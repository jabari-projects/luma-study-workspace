"""Sign-in gaps found while planning the admin help desk (2026-11-17).

1. Changing the account email needs the current password and a code sent to
   the new address, gives the same answer for taken addresses, and the old
   address is told. Deleting the account needs the password too.
2. Only Luma's own tokens sign in: no Supabase Auth tokens, no tokens without
   the pv claim.
3. /auth/verify-email does not hand a fresh token to an already-verified caller.
4. (Website headers are checked in the frontend hosting test.)
5. No JWT secret fallback (nor the old public dev secret), old routes and
   helpers stay deleted, and the reset email states the real link lifetime.
6. The websocket takes its token from a header, never from the URL.
Plus: analytics no longer crashes on a stale token (missing import).
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import jwt
import pytest
from fastapi import HTTPException, WebSocketDisconnect
from fastapi.testclient import TestClient

from app import analytics, auth, config, email_codes, main, passwords
from app.auth import create_access_token

from tests.test_security import (  # noqa: F401
    FakeSupabase,
    code_from_email,
    db,
    debug_logs,
    sent_emails,
)

PASSWORD = "right-password-123"


@pytest.fixture
def web(db):
    return TestClient(main.app)


@pytest.fixture
def clock(monkeypatch):
    """Moves the email-code clock (cooldowns, caps, code lifetimes) forward."""
    now = {"t": email_codes.utcnow()}
    monkeypatch.setattr(main.email_code_store, "_clock", lambda: now["t"])

    def advance(seconds):
        now["t"] = now["t"] + timedelta(seconds=seconds)

    return advance


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def make_user(db, **fields):
    row = db.user(
        email=fields.pop("email", "student@example.com"),
        username=fields.pop("username", "student_one"),
        email_verified=fields.pop("email_verified", True),
        password=fields.pop("password", passwords.hash_password(PASSWORD)),
        **fields,
    )
    db.tables.setdefault("profiles", []).append({"user_id": row["id"], "username": row["username"]})
    return row


# ---------------------------------------------------------------- 1. email change


def test_email_change_without_password_is_refused(web, db, sent_emails):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    r = web.put("/me/email", json={"new_email": "thief@example.com"}, headers=bearer(token))
    assert r.status_code == 422
    assert db.users()[0]["email"] == "student@example.com"
    assert sent_emails == []


def test_email_change_with_wrong_password_is_refused(web, db, sent_emails):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    r = web.put(
        "/me/email",
        json={"new_email": "thief@example.com", "current_password": "not-it"},
        headers=bearer(token),
    )
    assert r.status_code == 400
    assert r.json()["error_code"] == "wrong_password"
    assert db.users()[0]["email"] == "student@example.com"
    assert sent_emails == []


def start_change(web, token, new_email, password=PASSWORD):
    return web.put("/me/email", json={"new_email": new_email, "current_password": password},
                   headers=bearer(token))


def confirm_change(web, token, new_email, code):
    return web.post("/me/email/confirm", json={"new_email": new_email, "code": code}, headers=bearer(token))


def test_email_change_waits_for_the_code_then_tells_the_old_address(web, db, sent_emails):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    r = start_change(web, token, "New.Address@Example.com")
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "code_sent_if_possible"
    # Nothing changes until the code is entered.
    assert db.users()[0]["email"] == "student@example.com"
    assert db.users()[0]["email_verified"] is True
    assert [m["to"] for m in sent_emails] == ["new.address@example.com"]
    code = code_from_email(sent_emails[0]["html"])
    assert "move your Luma account to this email" in sent_emails[0]["html"]

    r = confirm_change(web, token, "new.address@example.com", code)
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "new.address@example.com"
    user = db.users()[0]
    assert user["email"] == "new.address@example.com"
    assert user["email_verified"] is True  # the code proved the new inbox

    to_old = [m for m in sent_emails if m["to"] == "student@example.com"]
    assert len(to_old) == 1 and to_old[0]["subject"] == "Your Luma email was changed"
    # The notice names the new address only masked, and points to help.
    assert "new.address@example.com" not in to_old[0]["html"]
    assert "n\u2022\u2022\u2022@example.com" in to_old[0]["html"]
    assert "help@lumastudyhub.com" in to_old[0]["html"]
    # The code works once.
    assert confirm_change(web, token, "new.address@example.com", code).status_code == 400


def test_wrong_code_does_not_change_the_email(web, db, sent_emails):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    start_change(web, token, "new@example.com")
    code = code_from_email(sent_emails[0]["html"])
    wrong = "000000" if code != "000000" else "111111"
    r = confirm_change(web, token, "new@example.com", wrong)
    assert r.status_code == 400 and r.json()["error_code"] == "code_incorrect"
    # A code for one new address can't confirm a different one.
    r = confirm_change(web, token, "other@example.com", code)
    assert r.status_code == 400 and r.json()["error_code"] == "code_incorrect"
    assert db.users()[0]["email"] == "student@example.com"


def test_password_tries_are_limited_per_account(web, db, sent_emails):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    codes = [start_change(web, token, "thief@example.com", "guess").status_code for _ in range(6)]
    assert codes[:5] == [400] * 5
    assert codes[5] == 429
    # Even the right password waits out the window now.
    assert start_change(web, token, "thief@example.com").status_code == 429
    assert db.users()[0]["email"] == "student@example.com"


def test_daily_password_cap_is_not_cleared_by_a_success(web, db, sent_emails, clock):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    tries = main.PASSWORD_CHECK_LIMIT - 1
    for round_number in range(main.PASSWORD_CHECK_DAILY_LIMIT // main.PASSWORD_CHECK_LIMIT):
        assert [start_change(web, token, "x@example.com", "guess").status_code for _ in range(tries)] == [400] * tries
        assert start_change(web, token, f"new{round_number}@example.com").status_code == 202
        clock(61)  # past the code cooldown
    r = start_change(web, token, "one-more@example.com")
    assert r.status_code == 429 and r.json()["error_code"] == "rate_limited"
    assert r.json()["retry_after"] == main.PASSWORD_CHECK_DAILY_WINDOW_SECONDS


def test_admin_email_cannot_be_changed_here(web, db, sent_emails):
    row = make_user(db, role="admin")
    token = create_access_token({"sub": row["id"]})
    r = start_change(web, token, "other@example.com")
    assert r.status_code == 403
    assert r.json()["error_code"] == "admin_email_locked"
    assert db.users()[0]["email"] == "student@example.com"
    assert sent_emails == []


def test_account_without_a_password_is_sent_to_forgot_password(web, db, sent_emails):
    row = make_user(db, password="")
    token = create_access_token({"sub": row["id"]})
    r = start_change(web, token, "other@example.com", "anything")
    assert r.status_code == 400
    assert r.json()["error_code"] == "password_needed"


def test_same_email_changes_nothing_and_sends_nothing(web, db, sent_emails):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    r = start_change(web, token, "STUDENT@example.com")
    assert r.status_code == 400 and r.json()["error_code"] == "same_email"
    assert db.users()[0]["email_verified"] is True
    assert sent_emails == []


def test_taken_email_gets_the_same_answer_and_nothing_is_sent(web, db, sent_emails, clock):
    row = make_user(db)
    make_user(db, email="taken@example.com", username="other_one")
    token = create_access_token({"sub": row["id"]})
    taken = start_change(web, token, "taken@example.com")
    assert sent_emails == []
    assert db.users()[0]["email"] == "student@example.com"
    # Asking again for it: same answer, still nothing sent.
    clock(61)
    resent = web.post("/me/email/resend", json={"new_email": "taken@example.com"}, headers=bearer(token))
    assert resent.status_code == 202 and resent.json() == taken.json()
    assert sent_emails == []
    # A free address after the cooldown: same answer.
    clock(61)
    free = start_change(web, token, "free@example.com")
    assert taken.status_code == free.status_code == 202
    assert taken.json() == free.json()
    # The taken address got a code row (never sent), so guessing locks like a real one.
    rows = [r for r in db.tables["email_codes"] if r["email"] == "taken@example.com"]
    assert len(rows) == 2 and {r["user_id"] for r in rows} == {row["id"]}
    clock(61)
    start_change(web, token, "taken@example.com")
    results = [confirm_change(web, token, "taken@example.com", f"{i:06d}").json()["error_code"]
               for i in range(email_codes.MAX_ATTEMPTS)]
    assert results[-1] == "code_locked"
    assert db.users()[0]["email"] == "student@example.com"


def test_new_code_goes_to_the_corrected_address_after_a_typo(web, db, sent_emails, clock):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    assert start_change(web, token, "typo@exmaple.com").status_code == 202
    # Inside the cooldown the account is told to wait, before a password try is used.
    early = start_change(web, token, "fixed@example.com", "guess")
    assert early.status_code == 429 and early.json()["error_code"] == "resend_cooldown"
    assert 0 < early.json()["retry_after"] <= 61
    assert main.password_check_daily_limiter.hit(f"user:{row['id']}")  # only 2 of 10 used so far
    clock(61)
    assert start_change(web, token, "fixed@example.com").status_code == 202
    assert sent_emails[-1]["to"] == "fixed@example.com"
    code = code_from_email(sent_emails[-1]["html"])
    assert confirm_change(web, token, "fixed@example.com", code).status_code == 200


def test_resend_needs_no_password_and_only_works_for_the_pending_address(web, db, sent_emails, clock):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})

    def resend(address):
        return web.post("/me/email/resend", json={"new_email": address}, headers=bearer(token))

    assert resend("new@example.com").json()["error_code"] == "no_pending_change"
    start_change(web, token, "new@example.com")
    first = code_from_email(sent_emails[-1]["html"])
    early = resend("new@example.com")
    assert early.status_code == 429 and early.json()["error_code"] == "resend_cooldown"
    clock(61)
    r = resend("new@example.com")
    assert r.status_code == 202, r.text
    assert set(r.json()) == {"status", "resend_after_seconds", "code_expires_in_seconds"}
    assert len(sent_emails) == 2 and sent_emails[-1]["to"] == "new@example.com"
    second = code_from_email(sent_emails[-1]["html"])
    # The new code replaces the old one.
    if first != second:
        assert confirm_change(web, token, "new@example.com", first).json()["error_code"] == "code_incorrect"
    # Only the newest pending address, never the current one or another one.
    clock(61)
    assert resend("other@example.com").json()["error_code"] == "no_pending_change"
    assert resend("student@example.com").json()["error_code"] == "no_pending_change"
    assert confirm_change(web, token, "new@example.com", second).status_code == 200
    # Once used, there is nothing to resend.
    clock(61)
    assert resend("new@example.com").json()["error_code"] == "no_pending_change"
    # No password try was used by the resends: 1 start only.
    for _ in range(main.PASSWORD_CHECK_DAILY_LIMIT - 1):
        assert main.password_check_daily_limiter.hit(f"user:{row['id']}")


def test_resend_stops_at_the_account_hourly_cap(web, db, sent_emails, clock):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    start_change(web, token, "new@example.com")
    for _ in range(email_codes.HOURLY_SEND_CAP - 1):
        clock(61)
        assert web.post("/me/email/resend", json={"new_email": "new@example.com"}, headers=bearer(token)).status_code == 202
    clock(61)
    r = web.post("/me/email/resend", json={"new_email": "new@example.com"}, headers=bearer(token))
    assert r.status_code == 429 and r.json()["error_code"] == "rate_limited"
    assert len(sent_emails) == email_codes.HOURLY_SEND_CAP


def test_change_codes_for_a_taken_address_do_not_use_up_its_inbox(web, db, sent_emails, clock):
    owner = make_user(db, email="owner@example.com", username="owner_one", email_verified=False)
    # Other accounts keep asking to move to the owner's address (never sent).
    for i in range(email_codes.INBOX_HOURLY_CAP + 1):
        other = make_user(db, email=f"other{i}@example.com", username=f"other_{i}")
        token = create_access_token({"sub": other["id"]})
        assert start_change(web, token, "owner@example.com").status_code == 202
    assert sent_emails == []
    # The owner can still get their own code.
    owner_token = create_access_token({"sub": owner["id"]})
    r = web.post("/auth/send-verification", headers=bearer(owner_token))
    assert r.status_code == 200, r.text
    assert sent_emails[-1]["to"] == "owner@example.com"


def test_address_taken_before_the_code_is_entered_is_refused(web, db, sent_emails):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    start_change(web, token, "race@example.com")
    code = code_from_email(sent_emails[0]["html"])
    make_user(db, email="race@example.com", username="fast_one")
    r = confirm_change(web, token, "race@example.com", code)
    assert r.status_code == 400 and r.json()["error_code"] == "email_taken"
    assert db.users()[0]["email"] == "student@example.com"


def test_code_for_the_current_address_cannot_confirm_a_change(web, db, sent_emails):
    row = make_user(db, email_verified=False)
    token = create_access_token({"sub": row["id"]})
    web.post("/auth/send-verification", headers=bearer(token))
    code = code_from_email(sent_emails[-1]["html"])
    r = confirm_change(web, token, "student@example.com", code)
    assert r.status_code == 400 and r.json()["error_code"] == "code_incorrect"
    # The code still works where it belongs.
    assert web.post("/auth/verify-email", json={"code": code}, headers=bearer(token)).status_code == 200


def delete_account(web, token, body):
    return web.request("DELETE", "/me/account", json=body, headers=bearer(token))


def test_delete_account_needs_the_password(web, db):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    assert delete_account(web, token, {}).status_code == 422
    r = delete_account(web, token, {"current_password": "not-it"})
    assert r.status_code == 400 and r.json()["error_code"] == "wrong_password"
    assert db.users()[0]["id"] == row["id"]


def test_delete_account_shares_the_password_limit(web, db):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    for _ in range(main.PASSWORD_CHECK_LIMIT):
        start_change(web, token, "x@example.com", "guess")
    r = delete_account(web, token, {"current_password": PASSWORD})
    assert r.status_code == 429
    assert db.users()[0]["id"] == row["id"]


def test_delete_account_without_a_password_is_sent_to_forgot_password(web, db):
    row = make_user(db, password="")
    token = create_access_token({"sub": row["id"]})
    r = delete_account(web, token, {"current_password": "anything"})
    assert r.status_code == 400 and r.json()["error_code"] == "password_needed"


# ---------------------------------------------------------------- 2. only Luma tokens


@pytest.fixture
def supabase_auth_calls(monkeypatch):
    """Record any call to Supabase Auth. Nothing should ever make one."""
    calls = []
    spy = SimpleNamespace(get_user=lambda token: calls.append(token))
    monkeypatch.setattr(main.supabase, "auth", spy, raising=False)
    monkeypatch.setattr(auth, "get_supabase", lambda: SimpleNamespace(auth=spy))
    monkeypatch.setattr(analytics, "get_supabase", lambda: SimpleNamespace(auth=spy))
    return calls


def _supabase_style_token(uid: str) -> str:
    # Signed with a different secret, the way Supabase Auth signs its tokens.
    return jwt.encode(
        {"sub": uid, "role": "authenticated", "aud": "authenticated",
         "exp": datetime.utcnow() + timedelta(hours=1)},
        "a-supabase-project-secret-that-is-not-ours-0123456",
        algorithm="HS256",
    )


def test_supabase_token_always_gets_401(web, db, supabase_auth_calls):
    row = make_user(db)
    r = web.get("/me/profile", headers=bearer(_supabase_style_token(row["id"])))
    assert r.status_code == 401
    assert supabase_auth_calls == []


def test_ai_routes_refuse_supabase_tokens(db, supabase_auth_calls):
    row = make_user(db)
    request = SimpleNamespace(headers={"authorization": f"Bearer {_supabase_style_token(row['id'])}"})
    assert main.authenticate_ai_request(request) is None
    assert supabase_auth_calls == []


def test_analytics_ignores_supabase_tokens(db, supabase_auth_calls):
    row = make_user(db)
    token = _supabase_style_token(row["id"])
    assert analytics.get_optional_user_id(SimpleNamespace(credentials=token)) is None
    assert supabase_auth_calls == []


def test_analytics_records_stale_token_events_anonymously(db, monkeypatch):
    """Was a NameError (HTTPException not imported) -> 500."""

    def stale(_token):
        raise auth.StaleSessionError()

    monkeypatch.setattr(analytics, "validate_access_token", stale)
    assert analytics.get_optional_user_id(SimpleNamespace(credentials="old-token")) is None


def test_luma_token_without_pv_is_refused_while_the_user_exists(web, db):
    row = make_user(db)
    token = jwt.encode(
        {"sub": row["id"], "type": "access", "exp": datetime.utcnow() + timedelta(hours=1)},
        auth.get_jwt_secret_key(),
        algorithm=auth.JWT_ALGORITHM,
    )
    assert web.get("/me/profile", headers=bearer(token)).status_code == 401
    good = create_access_token({"sub": row["id"]})
    assert web.get("/me/profile", headers=bearer(good)).status_code == 200


def test_luma_token_without_exp_is_refused(web, db):
    row = make_user(db)
    token = jwt.encode(
        {"sub": row["id"], "type": "access", "pv": auth._current_fingerprint(row["id"])},
        auth.get_jwt_secret_key(),
        algorithm=auth.JWT_ALGORITHM,
    )
    assert web.get("/me/profile", headers=bearer(token)).status_code == 401


def test_no_token_is_issued_for_a_missing_user(db):
    with pytest.raises(HTTPException) as caught:
        create_access_token({"sub": "no-such-user"})
    assert caught.value.status_code == 401


# ---------------------------------------------------------------- 3. verify-email refresh


def _exp(token: str) -> int:
    return jwt.decode(token, options={"verify_signature": False})["exp"]


def test_verified_caller_gets_their_own_token_back_not_a_new_one(web, db):
    row = make_user(db, email_verified=True)
    token = create_access_token({"sub": row["id"]})
    r = web.post("/auth/verify-email", json={"code": "000000"}, headers=bearer(token))
    assert r.status_code == 200
    assert r.json()["access_token"] == token
    assert r.json()["user"]["email_verified"] is True


def test_old_token_cannot_be_renewed_through_verify_email(web, db):
    row = make_user(db, email_verified=True)
    # A token with about 1 hour left: verify-email must not stretch it to 24 hours.
    old_token = create_access_token({"sub": row["id"]}, expires_delta=auth.timedelta(hours=1))
    r = web.post("/auth/verify-email", json={"code": "123456"}, headers=bearer(old_token))
    assert r.status_code == 200
    assert _exp(r.json()["access_token"]) == _exp(old_token)


def test_unverified_caller_with_right_code_still_gets_signed_in(web, db, sent_emails):
    row = make_user(db, email_verified=False)
    token = create_access_token({"sub": row["id"]})
    assert web.post("/auth/send-verification", headers=bearer(token)).status_code == 200
    code = code_from_email(sent_emails[-1]["html"])
    r = web.post("/auth/verify-email", json={"code": code}, headers=bearer(token))
    assert r.status_code == 200 and r.json()["user"]["email_verified"] is True
    assert r.json()["access_token"]


# ---------------------------------------------------------------- 5. no fallbacks, no leftovers


@pytest.mark.parametrize("value", [None, "", "x" * 31])
def test_missing_or_short_jwt_secret_is_refused(value):
    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY"):
        config.check_jwt_secret_key(value)


def test_32_character_jwt_secret_is_accepted():
    config.check_jwt_secret_key("x" * 32)


def test_old_public_dev_secret_is_refused():
    with pytest.raises(RuntimeError, match="old public dev secret"):
        config.check_jwt_secret_key("luma-development-jwt-secret-key-2026")


def test_server_will_not_start_without_a_jwt_secret():
    env = {k: v for k, v in os.environ.items() if k.upper() != "JWT_SECRET_KEY"}
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        cwd=backend, env=env, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode != 0
    assert "RuntimeError" in result.stderr and "JWT_SECRET_KEY" in result.stderr


def test_env_alias_no_longer_sets_app_env(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("ENV", "production")
    assert config.load_settings().APP_ENV == "development"


@pytest.mark.parametrize("method, path", [
    ("get", "/users/search?query=a"),
    ("get", "/auth/verify?token=abc"),
    ("post", "/internal/supabase/user-updated"),
    ("post", "/internal/supabase/user-updated-test"),
    ("get", "/internal/debug/file"),
    ("get", "/protected"),
])
def test_old_routes_are_gone(web, method, path):
    assert getattr(web, method)(path).status_code == 404


@pytest.mark.parametrize("name", [
    "UserSearchResponse", "create_user", "set_subscription_status",
    "issue_password_reset_token_best_effort", "transcribe_audio_with_deepgram",
    "issue_email_verification_token", "issue_email_verification_token_best_effort",
    "send_verification_email_best_effort", "build_verification_email_html",
    "EMAIL_VERIFICATION_EXPIRE_HOURS", "build_public_api_url",
    "require_internal_webhook_secret", "JWT_ALGORITHM", "ACCESS_TOKEN_EXPIRE_MINUTES",
    "create_notification_best_effort", "create_notification", "dispatch_notification_event_best_effort",
    "dispatch_realtime_event_best_effort", "email_change_password_limiter", "_send_code_best_effort",
    "StaleSessionError",
])
def test_old_helpers_are_gone(name):
    assert not hasattr(main, name)


def test_old_auth_helpers_are_gone():
    assert not hasattr(auth, "_get_user_from_custom_jwt")
    assert not hasattr(email_codes.EmailCodeStore, "retire_for_user")


def test_old_settings_are_gone():
    for name in ("DEFAULT_DEV_JWT_SECRET", "_PRODUCTION_FALLBACK_JWT_SECRET"):
        assert not hasattr(config, name)
    for name in ("effective_jwt_secret_key", "using_fallback_jwt_secret",
                 "using_production_fallback_jwt_secret", "resolved_api_base_url",
                 "API_BASE_URL", "WEBHOOK_SECRET"):
        assert not hasattr(config.settings, name)
    assert not hasattr(auth, "allow_supabase_auth_fallback")


def test_reset_email_states_the_real_link_lifetime(web, db, sent_emails):
    make_user(db)
    assert web.post("/auth/request-reset", json={"email": "student@example.com"}).status_code == 200
    body = sent_emails[-1]["html"]
    assert main.PASSWORD_RESET_EXPIRE_MINUTES == 30
    assert f"works for {main.PASSWORD_RESET_EXPIRE_MINUTES} minutes" in body
    assert "hours" not in body


def test_verifying_and_changing_email_leave_old_link_columns_alone(web, db, sent_emails, monkeypatch):
    # The old link columns stay in the table until a migration drops them,
    # but the code no longer writes to them.
    row = make_user(db, email_verified=False, email_verification_token="kept")
    token = create_access_token({"sub": row["id"]})
    web.post("/auth/send-verification", headers=bearer(token))
    code = code_from_email(sent_emails[-1]["html"])
    assert web.post("/auth/verify-email", json={"code": code}, headers=bearer(token)).status_code == 200
    # Step past the 60 s resend cooldown so the change code is sent.
    later = email_codes.utcnow() + timedelta(minutes=2)
    monkeypatch.setattr(main.email_code_store, "_clock", lambda: later)
    assert start_change(web, token, "new@example.com").status_code == 202
    code = code_from_email(sent_emails[-1]["html"])
    assert confirm_change(web, token, "new@example.com", code).status_code == 200
    assert db.users()[0]["email_verification_token"] == "kept"


# ---------------------------------------------------------------- 6. websocket token


def test_websocket_refuses_a_token_in_the_url(web, db):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    with pytest.raises(WebSocketDisconnect):
        with web.websocket_connect(f"/ws?token={token}"):
            pass


def test_websocket_takes_the_token_from_a_header(web, db):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    with web.websocket_connect("/ws", headers=bearer(token)):
        assert row["id"] in main.connection_manager.active_connections


def test_websocket_takes_the_token_from_the_subprotocol(web, db):
    row = make_user(db)
    token = create_access_token({"sub": row["id"]})
    with web.websocket_connect("/ws", subprotocols=["bearer", token]) as ws:
        assert ws.accepted_subprotocol == "bearer"
