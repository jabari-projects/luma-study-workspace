"""Security/privacy tests: password hashing, login limits, reset/verify tokens,
log hygiene and publish metadata. Uses an in-memory fake Supabase; no network."""

from __future__ import annotations

import copy
import hashlib
import logging
import re
import threading
import uuid
from types import SimpleNamespace

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient

from app import flashcards, main, notes, passwords, publishing, summaries
from app.auth import create_access_token, get_current_user, get_current_user_id

OWNER_ID = "owner-1"


# ---------- Fake Supabase ----------


class FakeQuery:
    def __init__(self, db: "FakeSupabase", table: str):
        self.db = db
        self.table_name = table
        self.op = "select"
        self.payload = None
        self.filters: list[tuple[str, object]] = []
        self.single = False
        self.limit_n = None

    def select(self, *_args, **_kwargs):
        self.op = "select"
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def in_(self, column, values):
        self.filters.append((column, ("__in__", tuple(values))))
        return self

    def gte(self, column, value):
        self.filters.append((column, ("__gte__", value)))
        return self

    def is_(self, column, value):
        # PostgREST "is.null": the only form the app uses.
        assert value == "null", value
        self.filters.append((column, ("__is_null__",)))
        return self

    # Used by scripts/hash_existing_passwords.py (keyset paging and the
    # "still not a hash" conditional update).
    def gt(self, column, value):
        self.filters.append((column, ("__gt__", value)))
        return self

    @property
    def not_(self):
        self._negate_next = True
        return self

    def like(self, column, pattern):
        kind = "__not_like__" if getattr(self, "_negate_next", False) else "__like__"
        self._negate_next = False
        self.filters.append((column, (kind, pattern)))
        return self

    def ilike(self, column, pattern):
        # SQL ILIKE: % is any run, _ is one character, a backslash makes the next one literal.
        regex, i = "", 0
        while i < len(pattern):
            ch = pattern[i]
            if ch == "\\" and i + 1 < len(pattern):
                regex += re.escape(pattern[i + 1])
                i += 2
                continue
            regex += ".*" if ch == "%" else "." if ch == "_" else re.escape(ch)
            i += 1
        self.filters.append((column, ("__ilike__", re.compile(f"^{regex}$", re.IGNORECASE | re.DOTALL))))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def range(self, start, end):
        self.limit_n = end - start + 1
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def maybe_single(self):
        self.single = True
        return self

    def _matches(self, row):
        for column, value in self.filters:
            if isinstance(value, tuple) and value and value[0] == "__in__":
                if row.get(column) not in value[1]:
                    return False
            elif isinstance(value, tuple) and value and value[0] == "__gte__":
                if row.get(column) is None or not row.get(column) >= value[1]:
                    return False
            elif isinstance(value, tuple) and value and value[0] == "__is_null__":
                if row.get(column) is not None:
                    return False
            elif isinstance(value, tuple) and value and value[0] == "__gt__":
                if row.get(column) is None or not row.get(column) > value[1]:
                    return False
            elif isinstance(value, tuple) and value and value[0] == "__ilike__":
                cell = row.get(column)
                if not isinstance(cell, str) or not value[1].match(cell):
                    return False
            elif isinstance(value, tuple) and value and value[0] in ("__like__", "__not_like__"):
                cell, prefix = row.get(column), value[1].rstrip("%")
                hit = isinstance(cell, str) and cell.startswith(prefix)
                if cell is None or hit != (value[0] == "__like__"):
                    return False
            elif row.get(column) != value:
                return False
        return True

    def execute(self):
        # One statement at a time, like a real database (needed by the
        # compare-and-swap concurrency tests).
        with self.db.lock:
            return self._execute()

    def _execute(self):
        self.db.calls.append((self.table_name, self.op, list(self.filters), copy.deepcopy(self.payload)))
        if self.db.fail_updates_on == (self.table_name, self.op):
            raise RuntimeError("simulated database failure")
        rows = self.db.tables.setdefault(self.table_name, [])
        if self.op == "insert":
            row = {"id": str(uuid.uuid4()), "created_at": "2026-01-01T00:00:00", **self.payload}
            rows.append(row)
            return SimpleNamespace(data=[copy.deepcopy(row)])
        matched = [row for row in rows if self._matches(row)]
        if self.op == "update":
            for row in matched:
                row.update(copy.deepcopy(self.payload))
            return SimpleNamespace(data=copy.deepcopy(matched))
        if self.op == "delete":
            for row in matched:
                rows.remove(row)
            return SimpleNamespace(data=copy.deepcopy(matched))
        if self.limit_n is not None:
            matched = matched[: self.limit_n]
        if self.single:
            return SimpleNamespace(data=copy.deepcopy(matched[0])) if matched else None
        return SimpleNamespace(data=copy.deepcopy(matched))


class FakeSupabase:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.calls: list[tuple] = []
        self.fail_updates_on = None
        self.lock = threading.RLock()

    # The migration script asks the database whether the plain-text guard is installed.
    guard_installed = True

    def rpc(self, name, params=None):
        assert name == "luma_password_guard_installed"
        installed = self.guard_installed
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=installed))

    def table(self, name):
        return FakeQuery(self, name)

    def user(self, **fields):
        row = {
            "id": fields.pop("id", str(uuid.uuid4())),
            "email": "student@example.com",
            "username": "student_one",
            "email_verified": False,
            "email_verification_token": None,
            "email_verification_sent_at": None,
            "password_reset_token": None,
            "password_reset_sent_at": None,
            **fields,
        }
        self.tables.setdefault("users", []).append(row)
        return row

    def users(self):
        return self.tables.get("users", [])


@pytest.fixture
def db(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(main, "supabase", fake)
    for module in (notes, flashcards, summaries, publishing):
        monkeypatch.setattr(module, "get_supabase", lambda: fake)
    return fake


@pytest.fixture(autouse=True)
def clear_limiters():
    for limiter in (
        main.login_failure_limiter,
        main.password_reset_email_limiter,
        main.password_reset_ip_limiter,
        main.password_reset_email_global_limiter,
    ):
        limiter.clear()
    yield
    for limiter in (
        main.login_failure_limiter,
        main.password_reset_email_limiter,
        main.password_reset_ip_limiter,
        main.password_reset_email_global_limiter,
    ):
        limiter.clear()


@pytest.fixture
def sent_emails(monkeypatch):
    sent = []

    def fake_send_email(to_email, subject, html_body):
        sent.append({"to": to_email, "subject": subject, "html": html_body})
        return {"id": "email-1"}

    monkeypatch.setattr(main, "send_email", fake_send_email)
    return sent


@pytest.fixture
def api(db):
    main.app.dependency_overrides[get_current_user_id] = lambda: OWNER_ID
    main.app.dependency_overrides[get_current_user] = lambda: {"id": OWNER_ID}
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(get_current_user_id, None)
        main.app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def debug_logs(caplog):
    caplog.set_level(logging.DEBUG)
    return caplog


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def code_from_email(html_body: str) -> str:
    match = re.search(r">(\d{6})</p>", html_body)
    assert match, html_body
    return match.group(1)


def token_from_link(html_body: str, path: str) -> str:
    match = re.search(re.escape(path) + r"\?token=([A-Za-z0-9_\-]+)", html_body)
    assert match, html_body
    return match.group(1)


# ---------- Hashing helpers ----------


def test_hash_password_is_argon2id_and_verifies():
    hashed = passwords.hash_password("correct horse")
    assert hashed.startswith("$argon2id$")
    assert "correct horse" not in hashed
    assert passwords.verify_password(hashed, "correct horse") == (True, False)
    assert passwords.verify_password(hashed, "wrong horse") == (False, False)


def test_verify_password_legacy_plaintext_needs_rehash():
    assert passwords.verify_password("oldpass", "oldpass") == (True, True)
    assert passwords.verify_password("oldpass", "oldpasS") == (False, False)
    assert passwords.verify_password("", "") == (False, False)
    assert passwords.verify_password(None, "x") == (False, False)


def test_verify_password_flags_outdated_hash_parameters():
    weak = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1).hash("pw-12345")
    assert passwords.verify_password(weak, "pw-12345") == (True, True)


def test_verify_password_handles_garbage_argon_value():
    assert passwords.verify_password("$argon2id$garbage", "x") == (False, False)


# ---------- Login ----------


def login(api, email="student@example.com", password="secret-pass"):
    return api.post("/login", json={"email": email, "password": password})


def test_login_upgrades_legacy_plaintext_password(api, db):
    row = db.user(password="short1")  # old 6-char password still works
    response = login(api, password="short1")
    assert response.status_code == 200
    assert response.json()["user"]["id"] == row["id"]
    stored = db.users()[0]["password"]
    assert stored.startswith("$argon2id$")
    assert passwords.verify_password(stored, "short1") == (True, False)


def test_login_rehashes_outdated_hash(api, db):
    weak = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1).hash("secret-pass")
    db.user(password=weak)
    assert login(api).status_code == 200
    stored = db.users()[0]["password"]
    assert stored != weak
    assert passwords.verify_password(stored, "secret-pass") == (True, False)


def test_login_with_current_hash_does_not_rewrite(api, db):
    db.user(password=passwords.hash_password("secret-pass"))
    assert login(api).status_code == 200
    assert not [c for c in db.calls if c[0] == "users" and c[1] == "update"]


def test_login_never_filters_database_by_password(api, db):
    db.user(password=passwords.hash_password("secret-pass"))
    login(api)
    login(api, password="nope-nope")
    for table, op, filters, _payload in db.calls:
        if op == "select":
            assert all(column != "password" for column, _ in filters)


def test_login_still_succeeds_when_rehash_update_fails(api, db, debug_logs):
    db.user(password="legacy-plain")
    db.fail_updates_on = ("users", "update")
    response = login(api, password="legacy-plain")
    assert response.status_code == 200
    assert "Could not upgrade password hash" in debug_logs.text
    assert "legacy-plain" not in debug_logs.text


def test_login_wrong_password_is_401(api, db):
    db.user(password=passwords.hash_password("secret-pass"))
    response = login(api, password="wrong-pass")
    assert response.status_code == 401
    assert response.json() == {"detail": main.LOGIN_FAILED_MESSAGE}


def test_login_unknown_email_is_401_and_spends_hash_time(api, db, monkeypatch):
    burned = []
    monkeypatch.setattr(main, "burn_verification_time", lambda pw: burned.append(True))
    response = login(api, email="nobody@example.com")
    assert response.status_code == 401
    assert response.json() == {"detail": main.LOGIN_FAILED_MESSAGE}
    assert burned == [True]


def test_login_limiter_blocks_after_ten_failures(api, db):
    db.user(password=passwords.hash_password("secret-pass"))
    for _ in range(10):
        assert login(api, password="wrong-pass").status_code == 401
    blocked = login(api)  # even the right password is held back now
    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "Too many tries. Wait a few minutes and try again."}
    # Email matching is case-insensitive for the limiter key.
    assert login(api, email="STUDENT@example.com").status_code == 429
    # A different email from the same IP is unaffected.
    assert login(api, email="other@example.com").status_code == 401


def test_login_success_clears_failures(api, db):
    db.user(password=passwords.hash_password("secret-pass"))
    for _ in range(9):
        assert login(api, password="wrong-pass").status_code == 401
    assert login(api).status_code == 200
    for _ in range(10):
        assert login(api, password="wrong-pass").status_code == 401
    assert login(api).status_code == 429


def test_limiter_window_expires():
    clock = {"t": 0.0}
    limiter = main.SlidingWindowLimiter(2, 60, clock=lambda: clock["t"])
    assert limiter.hit("k") and limiter.hit("k")
    assert not limiter.hit("k")
    clock["t"] = 61
    assert limiter.hit("k")


# ---------- Signup ----------


def signup(api, password="brand-new-pass", **extra):
    body = {"email": "new@example.com", "password": password, "username": "new_student", **extra}
    return api.post("/signup", json=body)


def test_signup_stores_hash_and_survives_email_not_configured(api, db, debug_logs):
    # RESEND_API_KEY is unset in tests, so the real send_email raises.
    response = signup(api)
    assert response.status_code == 202
    assert response.json()["status"] == "check_email"
    assert "access_token" not in response.json()  # the emailed code logs new users in now
    assert db.users() == []  # no account until the code is entered
    stored = db.tables["email_codes"][0]["pending_password_hash"]
    assert stored.startswith("$argon2id$")
    assert passwords.verify_password(stored, "brand-new-pass")[0]
    assert "brand-new-pass" not in debug_logs.text


def test_signup_survives_resend_failure(api, db, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("resend down")

    monkeypatch.setattr(main, "send_email", boom)
    assert signup(api).status_code == 202


def test_signup_emails_code_and_stores_only_digest(api, db, sent_emails):
    assert signup(api).status_code == 202
    code = code_from_email(sent_emails[0]["html"])
    rows = db.tables["email_codes"]
    assert len(rows) == 1
    assert rows[0]["code_digest"] != code and code not in str(db.tables)
    assert db.users() == []


@pytest.mark.parametrize(
    "password, message",
    [
        ("short7!", "Use at least 8 characters for your password."),
        ("x" * 129, "Use 128 characters or fewer for your password."),
    ],
)
def test_signup_password_length_rules(api, db, password, message):
    response = signup(api, password=password)
    assert response.status_code == 400
    assert response.json() == {"detail": message, "error_code": "password_invalid"}
    assert db.users() == []


def test_signup_accepts_boundary_lengths(api, db, sent_emails):
    assert signup(api, password="x" * 8).status_code == 202
    assert signup(api, password="y" * 128, email="b@example.com", username="b_student").status_code == 202


# ---------- Verification ----------


def test_send_verification_returns_503_when_email_fails(api, db, monkeypatch):
    db.user(id=OWNER_ID, password="x")

    def boom(*_a, **_k):
        raise RuntimeError("resend down")

    monkeypatch.setattr(main, "send_email", boom)
    response = api.post("/auth/send-verification")
    assert response.status_code == 503
    assert response.json() == {
        "detail": "We couldn't send the email right now. Try again later.",
        "error_code": "email_send_failed",
    }


def test_send_verification_sends_code_stored_only_as_digest(api, db, sent_emails):
    db.user(id=OWNER_ID, password="x")
    body = api.post("/auth/send-verification").json()
    assert body["success"] is True and body["resend_after_seconds"] == 60
    code = code_from_email(sent_emails[0]["html"])
    assert code not in str(db.tables)
    token = create_access_token({"sub": OWNER_ID})
    ok = api.post("/auth/verify-email", json={"code": code}, headers={"Authorization": f"Bearer {token}"})
    assert ok.status_code == 200
    assert db.users()[0]["email_verified"] is True


# ---------- Password reset ----------

GENERIC_RESET = {"success": True, "message": "If an account with that email exists, a reset link has been sent"}


def test_request_reset_same_response_for_known_and_unknown(api, db, sent_emails):
    db.user(password="x")
    known = api.post("/auth/request-reset", json={"email": "student@example.com"})
    unknown = api.post("/auth/request-reset", json={"email": "ghost@example.com"})
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json() == GENERIC_RESET
    assert len(sent_emails) == 1
    assert sent_emails[0]["to"] == "student@example.com"


def test_request_reset_emails_frontend_link_and_stores_digest(api, db, sent_emails):
    db.user(password="x")
    api.post("/auth/request-reset", json={"email": "student@example.com"})
    html_body = sent_emails[0]["html"]
    origin = main.settings.frontend_app_origin
    assert f"{origin}/reset-password?token=" in html_body
    raw = token_from_link(html_body, "/reset-password")
    assert db.users()[0]["password_reset_token"] == sha(raw)
    assert raw not in str(db.tables)


@pytest.mark.parametrize("failure", ["send", "lookup", "store"])
def test_request_reset_never_raises(api, db, monkeypatch, failure, debug_logs):
    db.user(password="x")

    def boom(*_a, **_k):
        raise RuntimeError("down")

    if failure == "send":
        monkeypatch.setattr(main, "send_email", boom)
    elif failure == "lookup":
        monkeypatch.setattr(main, "get_user_by_email", boom)
    else:
        db.fail_updates_on = ("users", "update")
    response = api.post("/auth/request-reset", json={"email": "student@example.com"})
    assert response.status_code == 200
    assert response.json() == GENERIC_RESET
    assert "student@example.com" not in debug_logs.text


def test_request_reset_without_resend_configured_is_generic(api, db):
    db.user(password="x")
    response = api.post("/auth/request-reset", json={"email": "student@example.com"})
    assert response.json() == GENERIC_RESET


def test_request_reset_rate_limit_is_silent(api, db, sent_emails):
    db.user(password="x")
    for _ in range(5):
        response = api.post("/auth/request-reset", json={"email": "student@example.com"})
        assert response.json() == GENERIC_RESET
    assert len(sent_emails) == main.PASSWORD_RESET_PER_EMAIL_LIMIT


def test_request_reset_per_ip_limit(api, db, sent_emails):
    for i in range(main.PASSWORD_RESET_PER_IP_LIMIT + 3):
        db.user(email=f"s{i}@example.com", password="x", username=f"s{i}")
    for i in range(main.PASSWORD_RESET_PER_IP_LIMIT + 3):
        assert api.post("/auth/request-reset", json={"email": f"s{i}@example.com"}).json() == GENERIC_RESET
    assert len(sent_emails) == main.PASSWORD_RESET_PER_IP_LIMIT


def request_reset_token(api, db, sent_emails) -> str:
    api.post("/auth/request-reset", json={"email": "student@example.com"})
    return token_from_link(sent_emails[-1]["html"], "/reset-password")


def test_reset_stores_hash_and_clears_token(api, db, sent_emails):
    db.user(password="old-plain")
    raw = request_reset_token(api, db, sent_emails)
    response = api.post("/auth/reset", json={"token": raw, "new_password": "fresh-password"})
    assert response.status_code == 200
    stored = db.users()[0]
    assert stored["password"].startswith("$argon2id$")
    assert passwords.verify_password(stored["password"], "fresh-password")[0]
    assert stored["password_reset_token"] is None
    assert login(api, password="fresh-password").status_code == 200
    assert login(api, password="old-plain").status_code == 401


@pytest.mark.parametrize("new_password", ["short", "x" * 129])
def test_reset_enforces_length(api, db, sent_emails, new_password):
    db.user(password="old-plain")
    raw = request_reset_token(api, db, sent_emails)
    response = api.post("/auth/reset", json={"token": raw, "new_password": new_password})
    assert response.status_code == 400
    assert "characters" in response.json()["detail"]
    assert db.users()[0]["password"] == "old-plain"


def test_reset_rejects_digest_and_legacy_raw_tokens(api, db, sent_emails):
    db.user(password="old-plain")
    raw = request_reset_token(api, db, sent_emails)
    bad = api.post("/auth/reset", json={"token": sha(raw), "new_password": "fresh-password"})
    assert bad.status_code == 400

    db.users()[0]["password_reset_token"] = "legacy-raw"
    legacy = api.post("/auth/reset", json={"token": "legacy-raw", "new_password": "fresh-password"})
    assert legacy.status_code == 400


# ---------- Log hygiene ----------


def test_no_token_or_password_in_logs(api, db, sent_emails, debug_logs):
    db.user(password="legacy-plain-pw")
    login(api, password="legacy-plain-pw")
    login(api, password="wrong-guess-pw")
    ticket = signup(api, password="signup-secret-pw").json()["ticket"]
    code = code_from_email(sent_emails[0]["html"])
    wrong = "000000" if code != "000000" else "111111"
    api.post("/auth/verify-email", json={"email": "new@example.com", "ticket": ticket, "code": wrong})
    api.post("/auth/verify-email", json={"email": "new@example.com", "ticket": ticket, "code": code})
    raw_reset = request_reset_token(api, db, sent_emails)
    api.post("/auth/reset", json={"token": raw_reset, "new_password": "reset-secret-pw"})

    text = debug_logs.text
    for secret in (
        "legacy-plain-pw",
        "wrong-guess-pw",
        "signup-secret-pw",
        "reset-secret-pw",
        raw_reset,
        sha(raw_reset),
        code,
        ticket,
        "$argon2",
    ):
        assert secret not in text, secret


def test_log_link_helpers_do_not_log_tokens(debug_logs):
    main.log_password_reset_link("tok-BBB")
    assert "tok-BBB" not in debug_logs.text


def test_reset_email_html_escapes_values():
    body = main.build_password_reset_email_html('https://x.test/reset-password?token=a"><script>')
    assert "<script>" not in body
    assert "&quot;&gt;&lt;script&gt;" in body


# ---------- Publish metadata ----------

SPOOFED = {
    "published_by": "Famous Teacher",
    "published_at": "1999-01-01T00:00:00",
    "study_type": "malware",
    "updated_at": "1999-01-01T00:00:00",
}

ROUTES = [
    ("/notes", "note", {"title": "Cells", "content": "Mitochondria"}),
    ("/flashcards", "flashcards", {"title": "Cells", "cards": [{"front": "Q", "back": "A"}]}),
    ("/summaries", "summary", {"title": "Cells", "content": "Mitochondria"}),
]


@pytest.fixture
def owner(db):
    return db.user(id=OWNER_ID, username="real_owner", password="x")


@pytest.mark.parametrize("path, study_type, body", ROUTES)
def test_create_forces_private_and_ignores_spoofed_fields(api, db, owner, path, study_type, body):
    response = api.post(path, json={**body, **SPOOFED, "is_public": True})
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["is_public"] is False
    assert data["published_by"] is None
    assert data["published_at"] is None
    assert data["study_type"] == study_type
    assert data["updated_at"] != SPOOFED["updated_at"]
    assert data["user_id"] == OWNER_ID


@pytest.mark.parametrize("path, study_type, body", ROUTES)
def test_publish_uses_server_values(api, db, owner, path, study_type, body):
    item = api.post(path, json=body).json()
    response = api.put(f"{path}/{item['id']}", json={"is_public": True, **SPOOFED})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["is_public"] is True
    assert data["published_by"] == "real_owner"
    assert data["study_type"] == study_type
    assert data["published_at"] and data["published_at"] != SPOOFED["published_at"]
    assert data["updated_at"] != SPOOFED["updated_at"]

    # Re-saving while public keeps the original publish time.
    again = api.put(f"{path}/{item['id']}", json={"is_public": True, "published_at": "2000-01-01"}).json()
    assert again["published_at"] == data["published_at"]


@pytest.mark.parametrize("path, study_type, body", ROUTES)
def test_unpublish_clears_publish_fields(api, db, owner, path, study_type, body):
    item = api.post(path, json=body).json()
    api.put(f"{path}/{item['id']}", json={"is_public": True})
    data = api.put(f"{path}/{item['id']}", json={"is_public": False, **SPOOFED}).json()
    assert data["is_public"] is False
    assert data["published_by"] is None
    assert data["published_at"] is None


@pytest.mark.parametrize("path, study_type, body", ROUTES[1:])
def test_publish_requires_title(api, db, owner, path, study_type, body):
    item = api.post(path, json={**body, "title": "   "}).json()
    response = api.put(f"{path}/{item['id']}", json={"is_public": True})
    assert response.status_code == 400
    assert response.json() == {"detail": "Please give this study set a title before publishing."}
    blank = api.put(f"{path}/{item['id']}", json={"is_public": True, "title": "  "})
    assert blank.status_code == 400
    ok = api.put(f"{path}/{item['id']}", json={"is_public": True, "title": "Real title"})
    assert ok.status_code == 200 and ok.json()["is_public"] is True


@pytest.mark.parametrize("path, study_type, body", ROUTES)
def test_public_item_cannot_lose_its_title(api, db, owner, path, study_type, body):
    item = api.post(path, json=body).json()
    api.put(f"{path}/{item['id']}", json={"is_public": True})
    response = api.put(f"{path}/{item['id']}", json={"title": "   "})
    assert response.status_code == 400


def test_note_rejects_whitespace_title(api, db, owner):
    assert api.post("/notes", json={"title": "   ", "content": "x"}).status_code == 400
    item = api.post("/notes", json={"title": "Ok", "content": "x"}).json()
    assert api.put(f"/notes/{item['id']}", json={"title": "  "}).status_code == 400


def test_publisher_name_falls_back_to_profile_then_student(api, db):
    db.tables["profiles"] = [{"user_id": OWNER_ID, "username": "profile_name"}]
    assert publishing.lookup_publisher_name(OWNER_ID) == "profile_name"
    db.tables["profiles"] = []
    assert publishing.lookup_publisher_name(OWNER_ID) == "Student"


def test_publisher_lookup_failure_uses_student(monkeypatch):
    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(publishing, "get_supabase", boom)
    assert publishing.lookup_publisher_name(OWNER_ID) == "Student"


def test_updates_stay_owner_scoped(api, db, owner):
    db.tables.setdefault("notes", []).append(
        {"id": "someone-elses", "user_id": "other-user", "title": "Theirs", "content": "x", "created_at": "t"}
    )
    response = api.put("/notes/someone-elses", json={"is_public": True})
    assert response.status_code == 404
    assert db.tables["notes"][0].get("is_public") is None
    for table, op, filters, _payload in db.calls:
        if table == "notes" and op in {"update", "select", "delete"}:
            assert ("user_id", OWNER_ID) in filters


# ---------- One-off migration script ----------


def test_hash_existing_passwords_script_dry_run_and_apply(db, capsys):
    from scripts import hash_existing_passwords as script

    db.user(password="plain-one", email="a@example.com")
    db.user(password=passwords.hash_password("already"), email="b@example.com")
    db.user(password=None, email="c@example.com")

    counts = script.hash_plaintext_passwords(db, apply=False)
    assert counts["plaintext"] == 1 and counts["already_hashed"] == 1 and counts["empty"] == 1
    assert counts["updated"] == 0
    assert db.users()[0]["password"] == "plain-one"

    counts = script.hash_plaintext_passwords(db, apply=True)
    assert counts["updated"] == 1
    assert passwords.verify_password(db.users()[0]["password"], "plain-one") == (True, False)
    assert "plain-one" not in capsys.readouterr().out


def test_hash_existing_passwords_script_defaults_to_dry_run(monkeypatch, db, capsys):
    from app import supabase_client
    from scripts import hash_existing_passwords as script

    import dataclasses

    from app import config

    db.user(password="plain-one")
    # The script now insists on the service-role key (the anon key sees no rows under RLS).
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, SUPABASE_SERVICE_ROLE_KEY="fake-service-role"))
    monkeypatch.setattr(supabase_client, "is_supabase_configured", lambda: True)
    monkeypatch.setattr(supabase_client, "get_supabase", lambda: db)
    assert script.main([]) == 0
    out = capsys.readouterr().out
    assert "DRY RUN" in out and "plaintext: 1" in out and "plain-one" not in out
    assert db.users()[0]["password"] == "plain-one"


def test_access_log_token_query_is_redacted(debug_logs):
    access = logging.getLogger("uvicorn.access")
    access.info('%s - "%s %s HTTP/%s" %d', "1.2.3.4", "GET", "/auth/verify?token=SECRET123&x=1", "1.1", 200)
    assert "SECRET123" not in debug_logs.text
    assert "token=[redacted]&x=1" in debug_logs.text


# ---------- Follow-up hardening ----------


def test_validation_error_strips_input_and_ctx(api, db):
    r = api.post("/login", json={"email": "not-an-email", "password": "Hidden-Pass-1"})
    assert r.status_code == 422
    assert "Hidden-Pass-1" not in r.text
    for item in r.json()["detail"]:
        assert set(item) == {"loc", "msg", "type"}


def test_session_from_login_works_until_password_reset(api, db, sent_emails):
    from app.auth import validate_access_token

    db.user(password=passwords.hash_password("old-password-1"))
    token = api.post("/login", json={"email": "student@example.com", "password": "old-password-1"}).json()[
        "access_token"
    ]
    assert validate_access_token(token)["id"] == db.users()[0]["id"]

    api.post("/auth/request-reset", json={"email": "student@example.com"})
    reset = token_from_link(sent_emails[-1]["html"], "/reset-password")
    assert api.post("/auth/reset", json={"token": reset, "new_password": "new-password-1"}).status_code == 200

    main.app.dependency_overrides.pop(get_current_user, None)
    main.app.dependency_overrides.pop(get_current_user_id, None)
    r = api.get("/me/profile", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401

    fresh = api.post("/login", json={"email": "student@example.com", "password": "new-password-1"}).json()[
        "access_token"
    ]
    assert validate_access_token(fresh)["id"] == db.users()[0]["id"]


def test_legacy_login_upgrade_still_yields_valid_session(api, db):
    from app.auth import validate_access_token

    db.user(password="legacy-plain")
    token = api.post("/login", json={"email": "student@example.com", "password": "legacy-plain"}).json()[
        "access_token"
    ]
    assert db.users()[0]["password"].startswith("$argon2")
    assert validate_access_token(token)["id"] == db.users()[0]["id"]


def test_client_ip_uses_trusted_proxy_hop_only_when_configured(monkeypatch):
    from dataclasses import replace

    from starlette.requests import Request

    def req(xff):
        headers = [(b"x-forwarded-for", xff.encode())] if xff else []
        return Request({"type": "http", "method": "POST", "path": "/", "headers": headers, "client": ("10.0.0.1", 1)})

    assert main.get_client_ip(req("6.6.6.6, 9.9.9.9")) == "10.0.0.1"
    monkeypatch.setattr(main, "settings", replace(main.settings, TRUSTED_PROXY_HOPS=1))
    # The rightmost entry is the one the platform proxy appended.
    assert main.get_client_ip(req("6.6.6.6, 9.9.9.9")) == "9.9.9.9"
    assert main.get_client_ip(req("not an ip")) == "10.0.0.1"
    assert main.get_client_ip(req("")) == "10.0.0.1"


def test_limiter_evicts_least_recently_active_keys_first():
    from app.rate_limits import SlidingWindowLimiter

    limiter = SlidingWindowLimiter(2, 900, max_keys=3)
    limiter.record("a")
    limiter.record("b")
    limiter.record("c")
    limiter.record("a")  # "a" becomes most recent
    limiter.record("d")  # evicts "b"
    assert set(limiter._events) == {"a", "c", "d"}
    assert limiter.is_limited("a")


def test_limiter_prunes_expired_keys_globally():
    from app.rate_limits import SlidingWindowLimiter

    now = [0.0]
    limiter = SlidingWindowLimiter(5, 10, clock=lambda: now[0], prune_every=1)
    for i in range(100):
        limiter.record(f"k{i}")
    now[0] = 100.0
    limiter.record("fresh")
    assert list(limiter._events) == ["fresh"]
