"""Adversarial security probes for the password/token/publish hardening.

Tests in this file assert the SECURE behavior. A failing test here is a
finding, not a flaky test. In-memory fakes only; no network.
"""

from __future__ import annotations

import logging
import statistics
import threading
import time
from datetime import datetime, timedelta

import pytest
from starlette.requests import Request

from app import main, passwords, public_search
from app.auth import create_access_token, validate_access_token

# Reuse the builder's in-memory Supabase fake and fixtures.
from tests.test_security import (  # noqa: F401
    code_from_email,
    OWNER_ID,
    api,
    clear_limiters,
    db,
    debug_logs,
    sent_emails,
    sha,
    token_from_link,
)

LONE_SURROGATE = "abc\ud800defgh"


def fake_request(ip: str = "1.2.3.4") -> Request:
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": (ip, 1234)})


# ---------- Hash format edge cases ----------


@pytest.mark.parametrize("stored", [None, "", "$argon2", "$argon2id$garbage", 12345, b"bytes"])
def test_verify_password_rejects_malformed_stored_values(stored):
    assert passwords.verify_password(stored, "anything") == (False, False)
    assert passwords.verify_password(stored, "") == (False, False)


def test_spoofed_argon_prefix_plaintext_cannot_be_used_as_password():
    # A legacy plaintext that happens to start with "$argon2" must not match itself.
    assert passwords.verify_password("$argon2id$v=19$abc", "$argon2id$v=19$abc")[0] is False


@pytest.mark.parametrize("stored", [None, ""])
def test_login_with_empty_or_null_stored_password_is_401(api, db, stored):
    db.user(password=stored)
    for candidate in ("", "x", "None"):
        r = api.post("/login", json={"email": "student@example.com", "password": candidate})
        assert r.status_code == 401


def test_login_never_selects_by_password_column(api, db):
    db.user(password=passwords.hash_password("correct-horse"))
    api.post("/login", json={"email": "student@example.com", "password": "correct-horse"})
    for _table, _op, filters, _payload in db.calls:
        assert all(column != "password" for column, _ in filters)


# ---------- Unicode / length ----------


def test_login_lone_surrogate_password_does_not_500(api, db):
    db.user(password=passwords.hash_password("correct-horse"))
    r = api.post(
        "/login",
        content='{"email": "student@example.com", "password": "abc\\ud800defgh"}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code in (400, 401, 422), r.status_code


def test_login_lone_surrogate_unknown_email_does_not_500(api, db):
    r = api.post(
        "/login",
        content='{"email": "nobody@example.com", "password": "abc\\ud800defgh"}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code in (400, 401, 422), r.status_code


def test_login_lone_surrogate_legacy_user_does_not_500(api, db):
    db.user(password="legacy-plain")
    r = api.post(
        "/login",
        content='{"email": "student@example.com", "password": "abc\\ud800defgh"}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code in (400, 401, 422), r.status_code


def test_invalid_unicode_password_is_not_written_to_logs(db, debug_logs):
    # Pydantic rejects the lone surrogate (422), FastAPI's default handler then
    # tries to echo the input, JSON encoding fails -> 500, and the request-log
    # middleware's logger.exception traceback contains the password.
    from fastapi.testclient import TestClient

    client = TestClient(main.app, raise_server_exceptions=False)
    r = client.post(
        "/login",
        content='{"email": "student@example.com", "password": "Pw-Secret-\\ud800zz"}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code != 500
    assert "Pw-Secret-" not in debug_logs.text


def test_signup_lone_surrogate_password_does_not_500(api, db, sent_emails):
    r = api.post(
        "/signup",
        content='{"email": "new@example.com", "username": "new_user", "password": "abc\\ud800defgh"}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code in (400, 422), r.status_code
    assert not db.users()


def test_reset_lone_surrogate_token_does_not_500(api, db):
    r = api.post(
        "/auth/reset",
        content='{"token": "abc\\ud800", "new_password": "long-enough-pass"}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code in (400, 422), r.status_code


def test_129_char_password_rejected_and_128_unicode_accepted(api, db, sent_emails):
    r = api.post("/signup", json={"email": "a@example.com", "username": "aaa_user", "password": "x" * 129})
    assert r.status_code == 400
    r = api.post("/signup", json={"email": "b@example.com", "username": "bbb_user", "password": "\U0001F600" * 128})
    assert r.status_code == 202
    stored = db.tables["email_codes"][0]["pending_password_hash"]
    assert stored.startswith("$argon2id$") and "\U0001F600" not in stored


def test_seven_char_unicode_password_rejected(api, db, sent_emails):
    r = api.post("/signup", json={"email": "a@example.com", "username": "aaa_user", "password": "é" * 7})
    assert r.status_code == 400


# ---------- Timing / enumeration ----------


def _median_time(fn, n=5):
    samples = []
    for _ in range(n):
        start = time.perf_counter()
        fn()
        samples.append(time.perf_counter() - start)
    return statistics.median(samples)


def test_login_legacy_plaintext_wrong_password_not_faster_than_unknown_email(db):
    db.user(email="legacy@example.com", password="legacy-plain")
    unknown = _median_time(lambda: main.verify_user("nobody@example.com", "guess-guess"))
    legacy = _median_time(lambda: main.verify_user("legacy@example.com", "guess-guess"))
    # Unknown email burns one argon2 verify (~tens of ms); a legacy account
    # must not answer in microseconds, or it reveals that the account exists.
    assert legacy >= unknown * 0.4, (legacy, unknown)


def test_request_reset_timing_does_not_reveal_known_email(api, db, monkeypatch):
    db.user(email="known@example.com", password="x")

    def slow_send(to_email, subject, html_body):
        time.sleep(0.4)  # stand-in for the Resend HTTP round trip
        return {"id": "e"}

    monkeypatch.setattr(main, "send_email", slow_send)

    def call(email):
        start = time.perf_counter()
        r = api.post("/auth/request-reset", json={"email": email})
        return r, time.perf_counter() - start

    r_unknown, t_unknown = call("unknown@example.com")
    r_known, t_known = call("known@example.com")
    assert r_unknown.json() == r_known.json() and r_unknown.status_code == r_known.status_code
    assert abs(t_known - t_unknown) < 0.2, (t_known, t_unknown)


def test_login_status_codes_identical_known_vs_unknown(api, db):
    db.user(password=passwords.hash_password("correct-horse"))
    a = api.post("/login", json={"email": "student@example.com", "password": "wrong-guess"})
    b = api.post("/login", json={"email": "nobody@example.com", "password": "wrong-guess"})
    assert (a.status_code, a.json()) == (b.status_code, b.json())


# ---------- Login limiter ----------


def test_login_limiter_not_bypassed_by_email_case(api, db):
    db.user(password=passwords.hash_password("correct-horse"))
    for i in range(10):
        email = "STUDENT@example.com" if i % 2 else "student@EXAMPLE.com"
        api.post("/login", json={"email": email, "password": "wrong"})
    r = api.post("/login", json={"email": "student@example.com", "password": "correct-horse"})
    assert r.status_code == 429


def test_login_limiter_ignores_x_forwarded_for_header(api, db):
    db.user(password=passwords.hash_password("correct-horse"))
    for i in range(10):
        api.post(
            "/login",
            json={"email": "student@example.com", "password": "wrong"},
            headers={"X-Forwarded-For": f"10.0.0.{i}"},
        )
    r = api.post(
        "/login",
        json={"email": "student@example.com", "password": "wrong"},
        headers={"X-Forwarded-For": "10.9.9.9"},
    )
    assert r.status_code == 429


def test_login_limiter_holds_under_concurrent_burst(db, monkeypatch):
    calls = []
    lock = threading.Lock()

    def slow_verify(email, password):
        with lock:
            calls.append(1)
        time.sleep(0.2)
        return None

    monkeypatch.setattr(main, "verify_user", slow_verify)

    def attempt():
        try:
            main.login(main.LoginRequest(email="student@example.com", password="guess"), fake_request())
        except Exception:
            pass

    threads = [threading.Thread(target=attempt) for _ in range(30)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 30 parallel guesses (FastAPI runs sync routes on a 40-thread pool):
    # no more than the 10-failure budget may reach password verification.
    assert len(calls) <= main.LOGIN_FAILURE_LIMIT, len(calls)


def test_limiter_memory_bounded_for_many_distinct_keys():
    from app.rate_limits import SlidingWindowLimiter

    limiter = SlidingWindowLimiter(10, 900)
    for i in range(50_000):
        limiter.record(("1.2.3.4", f"user{i}@example.com"))
    # Unique-email spraying should not grow state without bound.
    assert len(limiter._events) <= 20_000, len(limiter._events)


# ---------- Request-reset abuse ----------


def test_attacker_cannot_block_victim_reset_email(api, db, sent_emails):
    db.user(email="victim@example.com", password="x")
    # The attacker burns the per-email budget from other IPs; the victim then
    # asks from their own network. (Route called directly to control the IP.)
    for i in range(3):
        main.request_password_reset(main.PasswordResetRequest(email="victim@example.com"), fake_request(f"6.6.6.{i}"))
    sent_emails.clear()
    main.request_password_reset(main.PasswordResetRequest(email="victim@example.com"), fake_request("9.9.9.9"))
    assert sent_emails, "victim's own reset request was silently dropped"


def test_request_reset_case_variants_share_email_limit(api, db, sent_emails):
    db.user(email="student@example.com", password="x")
    for email in ("student@example.com", "Student@example.com", "STUDENT@example.com", "student@Example.com"):
        api.post("/auth/request-reset", json={"email": email})
    assert len(sent_emails) <= main.PASSWORD_RESET_PER_EMAIL_LIMIT


# ---------- Reset tokens ----------


def _issue_reset(api, db, sent_emails):
    db.user(password=passwords.hash_password("old-password-1"))
    api.post("/auth/request-reset", json={"email": "student@example.com"})
    return token_from_link(sent_emails[-1]["html"], "/reset-password")


def test_reset_token_cannot_be_reused(api, db, sent_emails):
    token = _issue_reset(api, db, sent_emails)
    assert api.post("/auth/reset", json={"token": token, "new_password": "new-password-1"}).status_code == 200
    r = api.post("/auth/reset", json={"token": token, "new_password": "new-password-2"})
    assert r.status_code == 400
    ok, _ = passwords.verify_password(db.users()[0]["password"], "new-password-1")
    assert ok


def test_expired_reset_token_rejected_and_cleared(api, db, sent_emails):
    token = _issue_reset(api, db, sent_emails)
    db.users()[0]["password_reset_sent_at"] = (datetime.utcnow() - timedelta(hours=25)).isoformat()
    r = api.post("/auth/reset", json={"token": token, "new_password": "new-password-1"})
    assert r.status_code == 400
    assert db.users()[0]["password_reset_token"] is None


def test_digest_itself_is_not_accepted_as_reset_token(api, db, sent_emails):
    token = _issue_reset(api, db, sent_emails)
    stored = db.users()[0]["password_reset_token"]
    assert stored == sha(token) and stored != token
    assert api.post("/auth/reset", json={"token": stored, "new_password": "new-password-1"}).status_code == 400


def test_verification_token_cannot_be_used_as_reset_token(api, db, sent_emails):
    api.post("/signup", json={"email": "s@example.com", "username": "s_user", "password": "password-123"})
    code = code_from_email(sent_emails[-1]["html"])
    r = api.post("/auth/reset", json={"token": code, "new_password": "hijack-pass-1"})
    assert r.status_code == 400
    assert r.json()["error_code"] == "reset_invalid"


def test_password_reset_invalidates_existing_sessions(api, db, sent_emails):
    token = _issue_reset(api, db, sent_emails)
    user_id = db.users()[0]["id"]
    stolen_jwt = create_access_token({"sub": user_id})
    assert api.post("/auth/reset", json={"token": token, "new_password": "new-password-1"}).status_code == 200
    with pytest.raises(Exception):
        validate_access_token(stolen_jwt)


# ---------- Email HTML / links ----------


def test_reset_link_points_to_frontend_origin_and_is_escaped(api, db, sent_emails, monkeypatch):
    monkeypatch.setattr(main, "generate_password_reset_token", lambda: 'tok"><script>alert(1)</script>')
    db.user(password="x")
    api.post("/auth/request-reset", json={"email": "student@example.com"})
    body = sent_emails[-1]["html"]
    assert "<script>" not in body
    assert f'href="{main.settings.frontend_app_origin}/reset-password?token=' in body


def test_request_reset_ignores_host_header_for_link(api, db, sent_emails):
    db.user(password="x")
    api.post("/auth/request-reset", json={"email": "student@example.com"}, headers={"Host": "evil.example"})
    assert "evil.example" not in sent_emails[-1]["html"]


# ---------- Log hygiene ----------


def test_uvicorn_access_formatter_survives_token_redaction(debug_logs):
    from uvicorn.logging import AccessFormatter

    formatter = AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False)
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", "/auth/verify?token=SECRET123", "1.1", 200),
        None,
    )
    main._token_redaction_filter.filter(record)
    # Real uvicorn unpacks record.args into 5 fields; the filter must not
    # break that (otherwise every token-bearing access line raises).
    line = formatter.format(record)
    assert "SECRET123" not in line
    assert "/auth/verify" in line


def test_no_secrets_in_logs_across_full_flow(api, db, sent_emails, debug_logs):
    ticket = api.post("/signup", json={"email": "s@example.com", "username": "s_user", "password": "Sup3r-Secret-PW"}).json()["ticket"]
    verify_token = code_from_email(sent_emails[-1]["html"])
    api.post("/auth/verify-email", json={"email": "s@example.com", "ticket": ticket, "code": verify_token})
    api.post("/login", json={"email": "s@example.com", "password": "Wrong-PW-123"})
    api.post("/login", json={"email": "s@example.com", "password": "Sup3r-Secret-PW"})
    api.post("/auth/request-reset", json={"email": "s@example.com"})
    reset_token = token_from_link(sent_emails[-1]["html"], "/reset-password")
    api.post("/auth/reset", json={"token": reset_token, "new_password": "Another-Secret-PW"})
    text = debug_logs.text
    for secret in ("Sup3r-Secret-PW", "Wrong-PW-123", "Another-Secret-PW", verify_token, reset_token,
                   sha(verify_token), sha(reset_token)):
        assert secret not in text


def test_validation_error_does_not_echo_password(api, db):
    # Missing username: FastAPI's default 422 echoes the whole body as "input".
    r = api.post("/signup", json={"email": "a@example.com", "password": "Echo-Me-Secret-1"})
    assert r.status_code == 422
    assert "Echo-Me-Secret-1" not in r.text


# ---------- Response models ----------


def test_no_auth_response_contains_password_or_tokens(api, db, sent_emails):
    r = api.post("/signup", json={"email": "s@example.com", "username": "s_user", "password": "password-123"})
    assert set(r.json()) == {"status", "email", "ticket", "resend_after_seconds", "code_expires_in_seconds"}
    code = code_from_email(sent_emails[-1]["html"])
    verified = api.post("/auth/verify-email", json={"email": "s@example.com", "ticket": r.json()["ticket"], "code": code})
    login = api.post("/login", json={"email": "s@example.com", "password": "password-123"})
    for response in (verified, login):
        user = response.json()["user"]
        assert set(user) == {"id", "email", "username", "email_verified"}
    for route in main.app.routes:
        model = getattr(route, "response_model", None)
        fields = getattr(model, "model_fields", {}) or {}
        for name in fields:
            assert name not in {"password", "password_reset_token", "email_verification_token"}, route.path


# ---------- Publishing ----------


def test_cannot_unpublish_or_update_another_users_item(api, db):
    db.user(id=OWNER_ID, username="owner_name", password="x")
    db.tables.setdefault("notes", []).append(
        {"id": "victim-note", "user_id": "victim", "title": "V", "content": "c", "is_public": True,
         "published_by": "victim_name", "published_at": "2026-01-01", "created_at": "2026-01-01"}
    )
    for body in ({"is_public": False}, {"title": "pwned"}, {"is_public": True, "published_by": "x"}):
        assert api.put("/notes/victim-note", json=body).status_code == 404
    assert api.delete("/notes/victim-note").status_code == 404
    row = db.tables["notes"][0]
    assert row["is_public"] is True and row["title"] == "V" and row["published_by"] == "victim_name"


def test_unpublish_with_spoofed_published_by_clears_it(api, db):
    db.user(id=OWNER_ID, username="owner_name", password="x")
    note = api.post("/notes", json={"title": "T", "content": "c"}).json()
    api.put(f"/notes/{note['id']}", json={"is_public": True})
    r = api.put(f"/notes/{note['id']}", json={"is_public": False, "published_by": "admin", "published_at": "1999"})
    assert r.json()["published_by"] is None and r.json()["published_at"] is None


def test_spoofed_fields_without_is_public_are_ignored_on_public_item(api, db):
    db.user(id=OWNER_ID, username="owner_name", password="x")
    note = api.post("/notes", json={"title": "T", "content": "c"}).json()
    api.put(f"/notes/{note['id']}", json={"is_public": True})
    r = api.put(f"/notes/{note['id']}", json={"content": "new", "published_by": "admin", "study_type": "summary"})
    assert r.json()["published_by"] == "owner_name" and r.json()["study_type"] == "note"


@pytest.mark.parametrize("path, body", [
    ("/flashcards", {"title": "T", "cards": [{"front": "Q", "back": "A"}]}),
    ("/summaries", {"title": "T", "content": "c"}),
])
def test_whitespace_title_blocks_publish(api, db, path, body):
    db.user(id=OWNER_ID, username="owner_name", password="x")
    item = api.post(path, json=body).json()
    r = api.put(f"{path}/{item['id']}", json={"title": " \t\n ", "is_public": True})
    assert r.status_code == 400


def test_public_search_shows_current_username_not_stale_published_by(db, monkeypatch):
    """Rows published before the fix (or before a rename) carry a stored
    published_by. Public search must not let that override the owner's
    current username, or spoofed/stale names keep showing."""
    monkeypatch.setattr(public_search, "get_supabase", lambda: db)
    db.tables["profiles"] = [{"user_id": "u1", "username": "real_owner", "display_name": None, "avatar_url": None}]
    db.tables["notes"] = [
        {"id": "n1", "user_id": "u1", "title": "Cells", "content": "c", "tags": [], "is_public": True,
         "published_by": "luma_admin", "published_at": "2026-01-01", "created_at": "2026-01-01", "study_type": "note"}
    ]
    items = public_search._build_items("")
    assert items and items[0].username == "real_owner", items[0].username
