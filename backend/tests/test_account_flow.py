"""Account entry flow: pending signups finished by emailed codes, login,
verification for existing accounts, reset, the AI gate and the email-keyed
free AI allowance. In-memory fake Supabase and fake email sender only
(no network, no real email)."""

from __future__ import annotations

import hashlib
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import ai_allowance, email_codes, main, passwords
from app.auth import create_access_token

from tests.test_security import (  # noqa: F401
    FakeSupabase,
    code_from_email,
    db,
    debug_logs,
    sent_emails,
    token_from_link,
)

SIGNUP = {"email": "new@example.com", "username": "new_student", "password": "brand-new-pass"}


@pytest.fixture
def web(db):
    """A client with real token checks (no auth overrides)."""
    return TestClient(main.app)


@pytest.fixture
def clock(monkeypatch):
    now = {"t": datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(main.email_code_store, "_clock", lambda: now["t"])

    def advance(seconds):
        now["t"] = now["t"] + timedelta(seconds=seconds)

    return advance


def start(web, **overrides):
    r = web.post("/signup", json={**SIGNUP, **overrides})
    assert r.status_code == 202, r.text
    return r.json()


def verify(web, code, ticket, email="new@example.com"):
    return web.post("/auth/verify-email", json={"email": email, "ticket": ticket, "code": code})


def other_code(code: str) -> str:
    return "000000" if code != "000000" else "111111"


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def with_profile(db, row):
    db.tables.setdefault("profiles", []).append({"user_id": row["id"], "username": row["username"]})
    return row


# ---------- signup ----------


def test_signup_saves_a_pending_signup_not_an_account(web, db, sent_emails, clock):
    body = start(web)
    assert body["status"] == "check_email" and body["email"] == "new@example.com"
    assert len(body["ticket"]) >= 20
    assert body["resend_after_seconds"] == 60 and body["code_expires_in_seconds"] == 600
    assert db.users() == []
    row = db.tables["email_codes"][0]
    assert row["purpose"] == "signup" and row["user_id"] is None
    assert row["pending_password_hash"].startswith("$argon2id$")
    assert body["ticket"] not in str(db.tables)  # only a digest of the ticket is stored
    assert len(sent_emails) == 1 and sent_emails[0]["to"] == "new@example.com"


def test_code_and_ticket_create_the_verified_account(web, db, sent_emails, clock):
    body = start(web)
    code = code_from_email(sent_emails[0]["html"])
    r = verify(web, f" {code[:3]}-{code[3:]} ", body["ticket"])  # pasted with spaces/dash
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email_verified"] is True
    user = db.users()[0]
    assert user["email_verified"] is True and user["username"] == "new_student"
    assert passwords.verify_password(user["password"], "brand-new-pass")[0]
    me = web.get("/me/profile", headers=bearer(r.json()["access_token"]))
    assert me.status_code == 200 and me.json()["email_verified"] is True


def test_capital_letters_in_email_work_everywhere(web, db, sent_emails, clock):
    body = start(web, email="New@Example.COM")
    assert body["email"] == "new@example.com"
    code = code_from_email(sent_emails[0]["html"])
    assert verify(web, code, body["ticket"], email="NEW@example.com").status_code == 200
    login = web.post("/login", json={"email": "New@Example.Com", "password": "brand-new-pass"})
    assert login.status_code == 200
    web.post("/auth/request-reset", json={"email": "NEW@EXAMPLE.COM"})
    assert sent_emails[-1]["to"] == "new@example.com" and "/reset-password?token=" in sent_emails[-1]["html"]


def test_someone_else_cannot_claim_your_email_first(web, db, sent_emails, clock):
    """Attacker starts a signup with the victim's email; the victim signs up too."""
    attacker = start(web, username="attacker_name", password="attacker-pass")
    victim = start(web, username="victim_name", password="victim-password")
    attacker_code = code_from_email(sent_emails[0]["html"])  # lands in the victim's inbox
    victim_code = code_from_email(sent_emails[1]["html"])
    # No account exists yet, so the attacker can't log in.
    assert web.post("/login", json={"email": "new@example.com", "password": "attacker-pass"}).status_code == 401
    # The attacker's code can't finish the victim's signup (wrong ticket for it).
    if attacker_code != victim_code:
        assert verify(web, attacker_code, victim["ticket"]).json()["error_code"] == "code_incorrect"
    # The attacker's ticket is useless without the code from the victim's inbox.
    if attacker_code != victim_code:
        assert verify(web, victim_code, attacker["ticket"]).json()["error_code"] == "code_incorrect"
    ok = verify(web, victim_code, victim["ticket"])
    assert ok.status_code == 200 and ok.json()["user"]["username"] == "victim_name"
    assert web.post("/login", json={"email": "new@example.com", "password": "attacker-pass"}).status_code == 401
    # Even if the attacker later got their own code, the email is taken now.
    late = verify(web, attacker_code, attacker["ticket"])
    assert late.status_code == 400 and late.json()["error_code"] == "account_exists"
    assert len(db.users()) == 1


def test_duplicate_signup_for_existing_account_changes_nothing_and_sends_one_notice(web, db, sent_emails, clock):
    db.user(email="new@example.com", username="owner", email_verified=True,
            password=passwords.hash_password("owner-password"))
    first = start(web)
    again = start(web)
    assert set(first) == set(again)
    assert len(db.users()) == 1
    assert passwords.verify_password(db.users()[0]["password"], "owner-password")[0]
    # Only decoy rows (they can never finish a signup and no code is emailed).
    assert all(r["purpose"] == "signup" and r["user_id"] is None for r in db.tables["email_codes"])
    assert len(sent_emails) == 1 and "already have a Luma account" in sent_emails[0]["html"]


def test_legacy_unverified_account_is_not_touched_by_signup(web, db, sent_emails, clock):
    db.user(email="new@example.com", username="legacy_one", email_verified=None, password="legacy-plain")
    start(web)
    assert db.users()[0]["email_verified"] is None and db.users()[0]["password"] == "legacy-plain"
    assert "already have a Luma account" in sent_emails[0]["html"]


def test_new_and_existing_email_get_the_same_answer(web, db, sent_emails, clock):
    db.user(email="taken@example.com", username="someone", email_verified=True, password="x")
    new = start(web)
    existing = start(web, email="taken@example.com", username="brand_new")
    for body in (new, existing):
        body.pop("email")
        body.pop("ticket")
    assert new == existing


def test_signup_timing_is_padded_the_same_for_new_and_existing(web, db, monkeypatch):
    db.user(email="taken@example.com", username="someone", email_verified=True, password="x")
    monkeypatch.setattr(main, "AUTH_NEUTRAL_RESPONSE_SECONDS", 0.5)
    monkeypatch.setattr(main, "_run_email_job", lambda job, *args: None)

    def timed(**overrides):
        started = time.perf_counter()
        start(web, **overrides)
        return time.perf_counter() - started

    new, existing = timed(), timed(email="taken@example.com", username="other_name")
    # Windows sleep can wake a few ms early; both must sit at the padded floor.
    assert 0.47 <= new < 0.75 and 0.47 <= existing < 0.75, (new, existing)
    assert abs(new - existing) < 0.15, (new, existing)


def test_username_check_does_not_depend_on_email(web, db, sent_emails, clock):
    db.user(email="someone@example.com", username="new_student", password="x")
    for email in ("someone@example.com", "different@example.com"):
        r = web.post("/signup", json={**SIGNUP, "email": email})
        assert r.status_code == 400 and r.json()["error_code"] == "username_taken"


def test_signup_ip_limit(web, db, sent_emails, clock):
    for i in range(main.SIGNUP_PER_IP_LIMIT):
        start(web, email=f"s{i}@example.com", username=f"s_{i}")
    blocked = web.post("/signup", json={**SIGNUP, "email": "late@example.com", "username": "late_one"})
    assert blocked.status_code == 429
    assert blocked.json()["error_code"] == "rate_limited" and blocked.json()["retry_after"] > 0


# ---------- checking codes ----------


def test_wrong_code_wrong_ticket_and_unknown_email_look_the_same(web, db, sent_emails, clock):
    body = start(web)
    code = code_from_email(sent_emails[0]["html"])
    expected = {"detail": main.CODE_INCORRECT_MESSAGE, "error_code": "code_incorrect"}
    for r in (
        verify(web, other_code(code), body["ticket"]),
        verify(web, code, "not-the-ticket"),
        verify(web, "123456", "some-ticket", email="ghost@example.com"),
        web.post("/auth/verify-email", json={"email": "new@example.com", "code": code}),  # no ticket, no login
    ):
        assert r.status_code == 400 and r.json() == expected


def test_expired_code(web, db, sent_emails, clock):
    body = start(web)
    code = code_from_email(sent_emails[0]["html"])
    clock(email_codes.CODE_TTL_SECONDS + 1)
    r = verify(web, code, body["ticket"])
    assert r.status_code == 400 and r.json()["error_code"] == "code_expired"
    assert db.users() == []


def test_code_is_single_use(web, db, sent_emails, clock):
    body = start(web)
    code = code_from_email(sent_emails[0]["html"])
    assert verify(web, code, body["ticket"]).status_code == 200
    assert verify(web, code, body["ticket"]).json()["error_code"] == "code_incorrect"
    assert len(db.users()) == 1


def test_code_locks_after_five_wrong_tries_and_a_new_code_works(web, db, sent_emails, clock):
    body = start(web)
    code = code_from_email(sent_emails[0]["html"])
    results = [verify(web, other_code(code), body["ticket"]).json()["error_code"] for _ in range(email_codes.MAX_ATTEMPTS)]
    assert results == ["code_incorrect"] * (email_codes.MAX_ATTEMPTS - 1) + ["code_locked"]
    assert verify(web, code, body["ticket"]).json()["error_code"] == "code_locked"
    clock(61)
    web.post("/auth/resend-code", json={"email": "new@example.com", "ticket": body["ticket"]})
    assert verify(web, code_from_email(sent_emails[-1]["html"]), body["ticket"]).status_code == 200
    assert passwords.verify_password(db.users()[0]["password"], "brand-new-pass")[0]


def test_parallel_wrong_guesses_cannot_beat_the_attempt_limit(web, db, sent_emails, clock):
    body = start(web)
    code = code_from_email(sent_emails[0]["html"])
    outcomes = []

    def guess():
        outcomes.append(main.email_code_store.check_signup("new@example.com", body["ticket"], other_code(code)).status)

    threads = [threading.Thread(target=guess) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert db.tables["email_codes"][0]["attempts"] == email_codes.MAX_ATTEMPTS
    assert main.email_code_store.check_signup("new@example.com", body["ticket"], code).status == "locked"


def test_parallel_correct_code_creates_one_account(web, db, sent_emails, clock):
    body = start(web)
    code = code_from_email(sent_emails[0]["html"])
    statuses = []

    def go():
        statuses.append(verify(web, code, body["ticket"]).status_code)

    threads = [threading.Thread(target=go) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert statuses.count(200) == 1
    assert len(db.users()) == 1


def test_verify_per_email_limit(web, db, sent_emails, clock):
    for _ in range(main.VERIFY_CODE_PER_EMAIL_LIMIT):
        verify(web, "123456", "t", email="ghost@example.com")
    r = verify(web, "123456", "t", email="ghost@example.com")
    assert r.status_code == 429 and r.json()["error_code"] == "rate_limited"


def test_code_digest_is_keyed_not_plain_sha256(web, db, sent_emails, clock):
    start(web)
    code = code_from_email(sent_emails[0]["html"])
    stored = db.tables["email_codes"][0]["code_digest"]
    assert stored != hashlib.sha256(code.encode()).hexdigest()
    assert code not in str(db.tables)


# ---------- resending ----------


def test_resend_is_neutral_and_respects_cooldown_and_caps(web, db, sent_emails, clock):
    body = start(web)
    neutral = {"status": "sent_if_possible", "resend_after_seconds": 60}
    r = web.post("/auth/resend-code", json={"email": "new@example.com", "ticket": body["ticket"]})
    assert r.status_code == 202 and r.json() == neutral
    assert len(sent_emails) == 1  # cooldown
    for _ in range(email_codes.HOURLY_SEND_CAP + 2):
        clock(61)
        web.post("/auth/resend-code", json={"email": "new@example.com", "ticket": body["ticket"]})
    assert len(sent_emails) == email_codes.HOURLY_SEND_CAP
    for _ in range(30):
        clock(15 * 60)
        web.post("/auth/resend-code", json={"email": "new@example.com", "ticket": body["ticket"]})
    created = sorted(datetime.fromisoformat(r["created_at"]) for r in db.tables["email_codes"])
    for i, first in enumerate(created):
        assert len([t for t in created[i:] if (t - first).total_seconds() < 86400]) <= email_codes.DAILY_SEND_CAP


def test_strangers_signups_cannot_block_the_owners_signup(web, db, sent_emails, clock):
    # Someone makes many signups for the same inbox (up to the per-IP limit)...
    for i in range(main.SIGNUP_PER_IP_LIMIT - 1):
        start(web, username=f"flood_{i}")
        clock(1)
    # ...the owner's own signup still gets its code.
    owner = start(web, username="real_owner", password="owner-password")
    assert len(sent_emails) == main.SIGNUP_PER_IP_LIMIT
    ok = verify(web, code_from_email(sent_emails[-1]["html"]), owner["ticket"])
    assert ok.status_code == 200 and ok.json()["user"]["username"] == "real_owner"


def test_inbox_cap_still_limits_floods(web, db, sent_emails, clock, monkeypatch):
    monkeypatch.setattr(main.signup_ip_limiter, "hit", lambda key: True)  # many IPs
    for i in range(email_codes.INBOX_HOURLY_CAP + 5):
        start(web, username=f"flood_{i}")
        clock(1)
    assert len(sent_emails) == email_codes.INBOX_HOURLY_CAP


def test_code_checks_look_the_same_for_new_and_existing_emails(web, db, sent_emails, clock):
    db.user(email="taken@example.com", username="someone", email_verified=True, password="x")
    outcomes = {}
    for email, name in (("new@example.com", "a_name"), ("taken@example.com", "b_name")):
        body = start(web, email=email, username=name)
        tries = [verify(web, "000000", body["ticket"], email=email).json()["error_code"]
                 for _ in range(email_codes.MAX_ATTEMPTS)]
        clock(email_codes.CODE_TTL_SECONDS + 1)
        tries.append(verify(web, "000000", body["ticket"], email=email).json()["error_code"])
        outcomes[email] = tries
    assert outcomes["new@example.com"] == outcomes["taken@example.com"]


def test_new_code_replaces_old_one(web, db, sent_emails, clock):
    body = start(web)
    old = code_from_email(sent_emails[0]["html"])
    clock(61)
    web.post("/auth/resend-code", json={"email": "new@example.com", "ticket": body["ticket"]})
    new = code_from_email(sent_emails[1]["html"])
    if old != new:
        assert verify(web, old, body["ticket"]).json()["error_code"] == "code_incorrect"
    assert verify(web, new, body["ticket"]).status_code == 200


def test_resend_without_a_matching_ticket_sends_nothing(web, db, sent_emails, clock):
    db.user(email="done@example.com", username="done", email_verified=True, password="x")
    start(web)
    clock(61)
    for payload in (
        {"email": "ghost@example.com", "ticket": "x"},
        {"email": "done@example.com"},
        {"email": "new@example.com"},
        {"email": "new@example.com", "ticket": "wrong-ticket"},
    ):
        r = web.post("/auth/resend-code", json=payload)
        assert r.status_code == 202 and r.json()["status"] == "sent_if_possible"
    assert len(sent_emails) == 1  # only the signup's own code


# ---------- existing accounts (older signups, email changes) ----------


def legacy_unverified(db, email="old@example.com", password="legacy-plain"):
    return with_profile(db, db.user(email=email, username="old_one", email_verified=None, password=password))


def test_logged_in_account_verifies_with_code_and_token(web, db, sent_emails, clock):
    row = legacy_unverified(db)
    token = create_access_token({"sub": row["id"]})
    assert web.post("/auth/send-verification", headers=bearer(token)).status_code == 200
    code = code_from_email(sent_emails[0]["html"])
    assert web.post("/auth/verify-email", json={"code": code}).json()["error_code"] == "code_incorrect"  # no token
    r = web.post("/auth/verify-email", json={"code": code}, headers=bearer(token))
    assert r.status_code == 200 and r.json()["user"]["email_verified"] is True
    assert db.users()[0]["email_verified"] is True


def test_old_code_cannot_verify_a_new_email(web, db, sent_emails, clock):
    row = legacy_unverified(db)
    token = create_access_token({"sub": row["id"]})
    web.post("/auth/send-verification", headers=bearer(token))
    code_for_old_inbox = code_from_email(sent_emails[0]["html"])
    # Change the address inside the 60 s cooldown (no new code can be sent yet).
    assert web.put("/me/email", json={"new_email": "victim@example.com"}, headers=bearer(token)).status_code == 200
    r = web.post("/auth/verify-email", json={"code": code_for_old_inbox}, headers=bearer(token))
    assert r.status_code == 400 and r.json()["error_code"] == "code_incorrect"
    assert db.users()[0]["email_verified"] is False


def test_logged_in_resend_cooldown_is_specific(web, db, sent_emails, clock):
    row = legacy_unverified(db)
    token = create_access_token({"sub": row["id"]})
    assert web.post("/auth/send-verification", headers=bearer(token)).status_code == 200
    again = web.post("/auth/send-verification", headers=bearer(token))
    assert again.status_code == 429
    assert again.json()["error_code"] == "resend_cooldown" and 0 < again.json()["retry_after"] <= 61


# ---------- login, legacy users, AI gate ----------


def test_existing_verified_user_logs_in_normally(web, db):
    db.user(email="old@example.com", username="old_one", email_verified=True,
            password=passwords.hash_password("old-password"))
    r = web.post("/login", json={"email": "old@example.com", "password": "old-password"})
    assert r.status_code == 200 and r.json()["user"]["email_verified"] is True


@pytest.mark.parametrize("route", ["notes-from-text", "generate-notes", "transcribe"])
def test_legacy_unverified_user_logs_in_but_every_ai_route_is_locked(web, db, monkeypatch, route):
    legacy_unverified(db)
    r = web.post("/login", json={"email": "old@example.com", "password": "legacy-plain"})
    assert r.status_code == 200 and r.json()["user"]["email_verified"] is False
    assert db.users()[0]["email_verified"] is None  # not silently changed

    def must_not_run(*_a, **_k):
        raise AssertionError("AI was called")

    monkeypatch.setattr("app.capture.generate_study_notes", must_not_run)
    monkeypatch.setattr(main, "generate_notes_with_ai", must_not_run)
    monkeypatch.setattr(main, "transcribe_audio_bytes", must_not_run)
    headers = bearer(r.json()["access_token"])
    if route == "notes-from-text":
        blocked = web.post("/api/notes-from-text", headers=headers,
                           json={"text": "Plants make food from light. " * 10, "source_kind": "paste"})
    elif route == "generate-notes":
        blocked = web.post("/api/generate-notes", headers=headers, json={"image": "data:image/png;base64,AAAA"})
    else:
        blocked = web.post("/api/transcribe", headers=headers,
                           files={"audio": ("a.webm", b"\x1aE\xdf\xa3" + b"0" * 200, "audio/webm")})
    assert blocked.status_code == 403
    assert blocked.json()["error_code"] == "email_unverified"


def test_verified_user_passes_the_ai_gate(web, db, monkeypatch):
    db.user(email="ok@example.com", username="ok_one", email_verified=True,
            password=passwords.hash_password("ok-password"))
    token = web.post("/login", json={"email": "ok@example.com", "password": "ok-password"}).json()["access_token"]
    monkeypatch.setattr(main, "has_free_ai_daily_limit", lambda user_id, usage_type: False)
    monkeypatch.setattr(main, "record_ai_usage", lambda user_id, usage_type: None)
    monkeypatch.setattr(
        "app.capture.generate_study_notes",
        lambda *a, **k: {"title": "t", "summary": "s", "notes": "n", "flashcards": [], "key_terms": []},
    )
    r = web.post("/api/notes-from-text", headers=bearer(token),
                 json={"text": "Plants make food from light. " * 10, "source_kind": "paste"})
    assert r.status_code == 200, r.text


def test_wrong_password_message(web, db):
    db.user(email="old@example.com", username="old_one", password=passwords.hash_password("right-pass"))
    r = web.post("/login", json={"email": "old@example.com", "password": "wrong-pass"})
    assert r.status_code == 401 and r.json() == {"detail": main.LOGIN_FAILED_MESSAGE}


# ---------- password reset ----------


def request_reset(web, sent_emails, email="old@example.com"):
    web.post("/auth/request-reset", json={"email": email})
    return token_from_link(sent_emails[-1]["html"], "/reset-password")


def test_reset_signs_out_old_sessions_and_is_single_use(web, db, sent_emails):
    with_profile(db, db.user(email="old@example.com", username="old_one", email_verified=False,
                             password=passwords.hash_password("old-password")))
    old_token = web.post("/login", json={"email": "old@example.com", "password": "old-password"}).json()["access_token"]
    assert web.get("/me/profile", headers=bearer(old_token)).status_code == 200

    reset = request_reset(web, sent_emails)
    assert web.post("/auth/reset", json={"token": reset, "new_password": "new-password-1"}).status_code == 200
    assert web.get("/me/profile", headers=bearer(old_token)).status_code == 401
    replay = web.post("/auth/reset", json={"token": reset, "new_password": "another-pass-2"})
    assert replay.status_code == 400 and replay.json()["error_code"] == "reset_invalid"
    assert web.post("/login", json={"email": "old@example.com", "password": "new-password-1"}).status_code == 200
    # Opening the emailed link proved the inbox, so the email counts as checked.
    assert db.users()[0]["email_verified"] is True


def test_reset_link_expires_after_30_minutes(web, db, sent_emails):
    db.user(email="old@example.com", username="old_one", password="x")
    reset = request_reset(web, sent_emails)
    db.users()[0]["password_reset_sent_at"] = (datetime.utcnow() - timedelta(minutes=31)).isoformat()
    r = web.post("/auth/reset", json={"token": reset, "new_password": "new-password-1"})
    assert r.status_code == 400 and r.json()["error_code"] == "reset_invalid"


def test_parallel_reset_with_same_link_succeeds_once(web, db, sent_emails):
    db.user(email="old@example.com", username="old_one", password="x")
    reset = request_reset(web, sent_emails)
    statuses = []

    def go(i):
        statuses.append(web.post("/auth/reset", json={"token": reset, "new_password": f"parallel-pass-{i}"}).status_code)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert statuses.count(200) == 1


def test_reset_request_is_neutral_for_unknown_email(web, db, sent_emails):
    r = web.post("/auth/request-reset", json={"email": "ghost@example.com"})
    assert r.status_code == 200 and sent_emails == []


# ---------- free AI allowance by email ----------


@pytest.mark.parametrize(
    "variant",
    ["Name@Gmail.com", "name+study@gmail.com", "n.a.m.e@gmail.com", " NAME@googlemail.com "],
)
def test_email_normalization_shares_one_allowance(variant):
    assert ai_allowance.normalize_email(variant) == "name@gmail.com"
    assert ai_allowance.allowance_key("s", variant) == ai_allowance.allowance_key("s", "name@gmail.com")


def test_non_gmail_dots_are_kept():
    assert ai_allowance.normalize_email("a.b@school.edu") == "a.b@school.edu"
    assert ai_allowance.normalize_email("a.b+x@school.edu") == "a.b@school.edu"


def test_deleting_and_recreating_does_not_reset_allowance(db, monkeypatch):
    first = db.user(email="name@gmail.com", username="first", email_verified=True, password="x")
    for _ in range(main.settings.FREE_AI_DAILY_LIMIT):
        main.record_ai_usage(first["id"], "notes")
    # Account deleted (its own users and ai_usage rows go), then re-created with a variant address.
    db.tables["users"] = []
    db.tables["ai_usage"] = []
    second = db.user(email="Name+again@Gmail.com", username="second", email_verified=True, password="x")
    monkeypatch.setattr(main, "count_ai_usage_today", lambda user_id, usage_type: 0)
    assert main.has_free_ai_daily_limit(second["id"], "notes") is True


def test_account_deletion_never_touches_the_allowance_ledger():
    from app import account_deletion

    source = open(account_deletion.__file__, encoding="utf-8").read()
    assert "ai_allowance_usage" not in source


def test_allowance_fails_closed_when_ledger_unreadable(db, monkeypatch):
    row = db.user(email="a@example.com", username="a_user", email_verified=True, password="x")
    monkeypatch.setattr(main, "count_ai_usage_today", lambda user_id, usage_type: 0)
    monkeypatch.setattr(main.allowance_ledger, "used", lambda key, usage_type: None)
    assert main.has_free_ai_daily_limit(row["id"], "notes") is True


def test_parallel_uses_are_all_counted():
    fake = FakeSupabase()
    ledger = ai_allowance.AllowanceLedger(lambda: fake)
    threads = [threading.Thread(target=ledger.add_use, args=("k", "notes")) for _ in range(25)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert ledger.used("k", "notes") == 25


def test_one_free_ai_task_at_a_time_per_email():
    ledger = ai_allowance.AllowanceLedger(lambda: FakeSupabase())
    with ledger.single_flight("k") as first:
        with ledger.single_flight("k") as second:
            assert first is True and second is False
        with ledger.single_flight("other") as different:
            assert different is True
    with ledger.single_flight("k") as later:
        assert later is True


def test_premium_users_skip_the_one_at_a_time_lock():
    with main.free_ai_turn({"id": "u", "subscription_status": "premium"}) as a:
        with main.free_ai_turn({"id": "u", "subscription_status": "premium"}) as b:
            assert a is True and b is True


# ---------- logs ----------


def test_codes_tickets_and_passwords_never_logged(web, db, sent_emails, clock, debug_logs):
    body = start(web)
    code = code_from_email(sent_emails[0]["html"])
    verify(web, other_code(code), body["ticket"])
    clock(61)
    web.post("/auth/resend-code", json={"email": "new@example.com", "ticket": body["ticket"]})
    code2 = code_from_email(sent_emails[-1]["html"])
    verify(web, code2, body["ticket"])
    for secret in (code, code2, body["ticket"], "brand-new-pass", "new@example.com"):
        assert secret not in debug_logs.text, secret
