"""Password migration (scripts/hash_existing_passwords.py) on synthetic data.

Everything here is fake: an in-memory Supabase stand-in and, for the
wire-level test, a real postgrest client talking to an httpx MockTransport.
No network, no real database.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import logging
import uuid
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl, unquote

import httpx
import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from postgrest import SyncPostgrestClient

from app import main, passwords

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "hash_existing_passwords.py"
_spec = importlib.util.spec_from_file_location("hash_existing_passwords", SCRIPT_PATH)
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)

# Cheap argon2 parameters for the big-table tests only (real hashes, fast).
_fast_hasher = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)


def synthetic_password(n: int) -> str:
    # Distinctive, so a leak anywhere is easy to detect.
    return f"Zq7-SYNTHETIC-pw-{n:05d}-xK"


# ---------- In-memory fake Supabase (only what the script and /login use) ----------


class FakeQuery:
    def __init__(self, db: "FakeDB", table: str):
        self.db, self.table_name = db, table
        self.op, self.payload = "select", None
        self.filters: list[tuple[str, str, object]] = []
        self.limit_n = None
        self.single = False
        self._negate = False

    def select(self, *_a, **_k):
        self.op = "select"
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def _add(self, op, column, value):
        if self._negate:
            op, self._negate = "not." + op, False
        self.filters.append((op, column, value))
        return self

    def eq(self, column, value):
        return self._add("eq", column, value)

    def gt(self, column, value):
        return self._add("gt", column, value)

    def like(self, column, pattern):
        return self._add("like", column, pattern)

    @property
    def not_(self):
        self._negate = True
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def maybe_single(self):
        self.single = True
        return self

    @staticmethod
    def _like(value, pattern):
        assert pattern.endswith("%") and "%" not in pattern[:-1] and "_" not in pattern
        return isinstance(value, str) and value.startswith(pattern[:-1])

    def _matches(self, row):
        for op, column, value in self.filters:
            cell = row.get(column)
            if op == "eq" and cell != value:
                return False
            if op == "gt" and not (cell is not None and cell > value):
                return False
            if op == "like" and not self._like(cell, value):
                return False
            if op == "not.like" and (cell is None or self._like(cell, value)):
                return False  # SQL: NULL NOT LIKE x is NULL -> no match
        return True

    def execute(self):
        db = self.db
        db.calls.append((self.table_name, self.op, copy.deepcopy(self.filters), copy.deepcopy(self.payload)))
        rows = db.tables.setdefault(self.table_name, [])
        if self.op == "select":
            db.select_calls += 1
            if db.fail_select_on_call == db.select_calls:
                raise RuntimeError(f"simulated read failure {db.leak_bait}")
            matched = sorted((r for r in rows if self._matches(r)), key=lambda r: r["id"])
            if self.limit_n is not None:
                matched = matched[: self.limit_n]
            if self.single:
                return SimpleNamespace(data=copy.deepcopy(matched[0])) if matched else None
            return SimpleNamespace(data=copy.deepcopy(matched))
        if self.op == "update":
            target_id = next((v for op, c, v in self.filters if op == "eq" and c == "id"), None)
            if target_id in db.fail_update_ids:
                raise RuntimeError(f"simulated write failure {db.leak_bait}")
            if db.before_update:
                db.before_update(target_id)  # simulate a concurrent writer
            matched = [r for r in rows if self._matches(r)]
            for r in matched:
                r.update(copy.deepcopy(self.payload))
                db.writes_per_id[r["id"]] = db.writes_per_id.get(r["id"], 0) + 1
            return SimpleNamespace(data=copy.deepcopy(matched))
        raise AssertionError(f"unexpected op {self.op}")


class FakeDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {"users": []}
        self.calls: list[tuple] = []
        self.select_calls = 0
        self.fail_select_on_call = None
        self.fail_update_ids: set = set()
        self.before_update = None
        self.writes_per_id: dict = {}
        self.leak_bait = ""

    # The migration script asks the database whether the plain-text guard is installed.
    guard_installed = True

    def rpc(self, name, params=None):
        assert name == "luma_password_guard_installed"
        installed = self.guard_installed
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=installed))

    def table(self, name):
        return FakeQuery(self, name)

    def add_user(self, n: int, password):
        row = {
            "id": f"{n:08d}-0000-4000-8000-{uuid.uuid4().hex[:12]}",
            "email": f"synthetic.user{n}@example.com",
            "username": f"synthetic_{n}",
            "password": password,
        }
        self.tables["users"].append(row)
        return row

    def users(self):
        return self.tables["users"]

    def user(self, user_id):
        return next(r for r in self.users() if r["id"] == user_id)

    def update_calls(self):
        return [c for c in self.calls if c[1] == "update"]


@pytest.fixture
def db(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(main, "supabase", fake)
    return fake


@pytest.fixture(autouse=True)
def clear_login_limiter():
    main.login_failure_limiter.clear()
    yield
    main.login_failure_limiter.clear()


@pytest.fixture
def fast_hash(monkeypatch):
    monkeypatch.setattr(migration, "hash_password", lambda p: _fast_hasher.hash(p))


@pytest.fixture
def logs(caplog):
    caplog.set_level(logging.DEBUG)
    return caplog


def run(db, *args, capsys=None):
    code = migration.main(list(args), client=db)
    out = err = ""
    if capsys is not None:
        captured = capsys.readouterr()
        out, err = captured.out, captured.err
    return code, out, err


def parse_counts(out: str) -> dict:
    counts = {}
    for line in out.splitlines():
        line = line.strip()
        if ":" in line and line.split(":", 1)[1].strip().isdigit():
            key, value = line.split(":", 1)
            counts[key.strip()] = int(value)
    return counts


def assert_no_secrets(text: str, db: FakeDB, secrets):
    for secret in secrets:
        assert secret not in text
    for row in db.users():
        assert row["email"] not in text
        assert row["id"] not in text
        if isinstance(row.get("password"), str) and row["password"]:
            assert row["password"] not in text  # neither plaintext nor hash


def mixed_table(db: FakeDB):
    """5 plaintext, 2 already hashed, 2 empty/None."""
    plain = {}
    for n in range(5):
        pw = synthetic_password(n)
        plain[db.add_user(n, pw)["id"]] = pw
    hashed = {}
    for n in range(5, 7):
        pw = synthetic_password(n)
        hashed[db.add_user(n, passwords.hash_password(pw))["id"]] = pw
    db.add_user(7, "")
    db.add_user(8, None)
    return plain, hashed


# ---------- Safety switches ----------


def test_dry_run_changes_nothing_and_prints_counts_only(db, capsys, logs):
    plain, hashed = mixed_table(db)
    before = copy.deepcopy(db.users())

    code, out, err = run(db, capsys=capsys)

    assert code == 0
    assert db.users() == before
    assert db.update_calls() == []
    counts = parse_counts(out)
    assert counts == {
        "checked": 9, "already_hashed": 2, "unreadable_hash": 0,
        "empty": 2, "plaintext": 5, "failed": 0,
    }
    assert "DRY RUN" in out and err == ""
    assert_no_secrets(out + err + logs.text, db, list(plain.values()) + list(hashed.values()))


def test_apply_refuses_without_backup_flag_and_touches_nothing(db, capsys):
    mixed_table(db)
    code, out, err = run(db, "--apply", capsys=capsys)
    assert code == 2
    assert "backup" in err
    assert db.calls == []


@pytest.mark.parametrize("size", ["0", "1001", "-5"])
def test_bad_batch_size_is_refused(db, capsys, size):
    code, _, _ = run(db, "--batch-size", size, capsys=capsys)
    assert code == 2
    assert db.calls == []


def test_unknown_option_is_refused(db, capsys):
    code, _, _ = run(db, "--aply", capsys=capsys)
    assert code == 2
    assert db.calls == []


# ---------- Apply ----------


def test_apply_hashes_each_plaintext_row_once_and_leaves_others(db, capsys, logs):
    plain, hashed = mixed_table(db)
    hashed_before = {uid: db.user(uid)["password"] for uid in hashed}

    code, out, err = run(db, "--apply", "--i-have-a-backup", capsys=capsys)

    assert code == 0, err
    counts = parse_counts(out)
    assert counts["updated"] == 5 and counts["plaintext"] == 5
    assert counts["already_hashed"] == 2 and counts["empty"] == 2
    assert counts["failed"] == 0 and counts["changed_meanwhile"] == 0
    assert counts["not_done_this_run"] == 0

    for uid, pw in plain.items():
        stored = db.user(uid)["password"]
        assert stored.startswith("$argon2id$")
        assert passwords.verify_password(stored, pw)[0] is True
        assert db.writes_per_id[uid] == 1
    for uid, value in hashed_before.items():
        assert db.user(uid)["password"] == value  # untouched
        assert uid not in db.writes_per_id
    assert {r["password"] for r in db.users() if r["id"].startswith(("00000007", "00000008"))} == {"", None}

    # Every write carried the "still not a hash" guard and never the plaintext.
    for _table, _op, filters, payload in db.update_calls():
        assert ("not.like", "password", "$argon2%") in filters
        assert all(value not in plain.values() for _o, _c, value in filters)
        assert set(payload) == {"password"} and payload["password"].startswith("$argon2id$")

    assert_no_secrets(out + err + logs.text, db, list(plain.values()) + list(hashed.values()))


def test_second_apply_is_a_no_op(db, capsys):
    plain, _ = mixed_table(db)
    assert run(db, "--apply", "--i-have-a-backup", capsys=capsys)[0] == 0
    snapshot = copy.deepcopy(db.users())
    db.calls.clear()

    code, out, _ = run(db, "--apply", "--i-have-a-backup", capsys=capsys)

    assert code == 0
    assert db.users() == snapshot
    assert db.update_calls() == []
    counts = parse_counts(out)
    assert counts["plaintext"] == 0 and counts["updated"] == 0 and counts["already_hashed"] == 7


def test_verify_mode_exit_code_tracks_remaining_plaintext(db, capsys):
    mixed_table(db)
    code, out, _ = run(db, "--verify", capsys=capsys)
    assert code == 1 and parse_counts(out)["plaintext"] == 5
    assert db.update_calls() == []

    run(db, "--apply", "--i-have-a-backup", capsys=capsys)
    code, out, _ = run(db, "--verify", capsys=capsys)
    assert code == 0 and parse_counts(out)["plaintext"] == 0


def test_concurrent_login_upgrade_is_not_double_hashed(db, capsys):
    plain, _ = mixed_table(db)
    racing_id = next(iter(plain))
    login_hash = {}

    def concurrent_login(target_id):
        # Between the script's read and its write, the user logs in and
        # verify_user() stores its own fresh hash.
        if target_id == racing_id and racing_id not in login_hash:
            login_hash[racing_id] = passwords.hash_password(plain[racing_id])
            db.user(racing_id)["password"] = login_hash[racing_id]

    db.before_update = concurrent_login
    code, out, err = run(db, "--apply", "--i-have-a-backup", capsys=capsys)

    assert code == 0, err
    counts = parse_counts(out)
    assert counts["changed_meanwhile"] == 1 and counts["updated"] == 4
    stored = db.user(racing_id)["password"]
    assert stored == login_hash[racing_id]  # the login's hash survived
    assert racing_id not in db.writes_per_id  # the script wrote nothing to it
    assert passwords.verify_password(stored, plain[racing_id])[0] is True


def test_legacy_value_that_looks_like_a_hash_is_flagged_not_rewritten(db, capsys):
    row = db.add_user(1, "$argon2-not-really-a-hash")
    code, out, _ = run(db, "--apply", "--i-have-a-backup", capsys=capsys)
    assert code == 0
    assert parse_counts(out)["unreadable_hash"] == 1
    assert db.user(row["id"])["password"] == "$argon2-not-really-a-hash"
    code, _, _ = run(db, "--verify", capsys=capsys)
    assert code == 1  # verify does not pass while such a row exists


def test_non_text_password_counts_as_failure(db, capsys):
    db.add_user(1, 12345678)
    code, out, err = run(db, "--apply", "--i-have-a-backup", capsys=capsys)
    assert code == 1
    assert parse_counts(out)["failed"] == 1
    assert "12345678" not in out + err


# ---------- Login before and after migration (real /login route) ----------


def login(api, row, password):
    return api.post("/login", json={"email": row["email"], "password": password})


def test_login_works_after_migration_and_has_no_plaintext_fallback(db, capsys, logs):
    pw = synthetic_password(1)
    row = db.add_user(1, pw)
    assert run(db, "--apply", "--i-have-a-backup", capsys=capsys)[0] == 0
    stored = db.user(row["id"])["password"]
    assert stored.startswith("$argon2id$")

    api = TestClient(main.app)
    ok = login(api, row, pw)
    assert ok.status_code == 200 and ok.json()["user"]["id"] == row["id"]
    assert login(api, row, pw + "x").status_code == 401
    assert login(api, row, "Zq7-SYNTHETIC-wrong-xK").status_code == 401
    # Typing the stored hash itself must never work (no plaintext fallback).
    assert login(api, row, stored).status_code == 401
    assert passwords.verify_password(stored, stored) == (False, False)
    # Login did not need to rewrite an up-to-date hash.
    assert db.user(row["id"])["password"] == stored

    assert pw not in logs.text


def test_user_who_logs_in_before_migration_is_upgraded_then_skipped(db, capsys, logs):
    early_pw, late_pw = synthetic_password(1), synthetic_password(2)
    early = db.add_user(1, early_pw)
    late = db.add_user(2, late_pw)
    api = TestClient(main.app)

    assert login(api, early, early_pw).status_code == 200
    upgraded = db.user(early["id"])["password"]
    assert upgraded.startswith("$argon2id$")
    db.calls.clear()  # only look at what the script does from here

    code, out, _ = run(db, "--apply", "--i-have-a-backup", capsys=capsys)
    assert code == 0
    counts = parse_counts(out)
    assert counts["already_hashed"] == 1 and counts["updated"] == 1
    assert db.user(early["id"])["password"] == upgraded
    assert all(f[2] != early["id"] for c in db.update_calls() for f in c[2] if f[1] == "id")

    assert login(api, early, early_pw).status_code == 200
    assert login(api, late, late_pw).status_code == 200
    assert login(api, late, early_pw).status_code == 401
    assert early_pw not in out + logs.text and late_pw not in out + logs.text


# ---------- Large tables, paging and partial failure ----------


def big_table(db: FakeDB, n: int = 2500):
    secrets = {}
    for i in range(n):
        pw = synthetic_password(i)
        secrets[db.add_user(i, pw)["id"]] = pw
    return secrets


def test_pages_through_2500_rows(db, capsys, fast_hash):
    secrets = big_table(db)
    code, out, err = run(db, "--apply", "--i-have-a-backup", "--batch-size", "500", capsys=capsys)
    assert code == 0, err
    counts = parse_counts(out)
    assert counts["checked"] == 2500 and counts["updated"] == 2500
    assert db.select_calls == 6  # 5 full pages + 1 empty page
    assert all(v == 1 for v in db.writes_per_id.values()) and len(db.writes_per_id) == 2500
    assert all(r["password"].startswith("$argon2") for r in db.users())
    assert_no_secrets(out + err, db, secrets.values())


def test_mid_run_read_failure_reports_progress_and_rerun_finishes(db, capsys, logs, fast_hash):
    secrets = big_table(db)
    db.leak_bait = synthetic_password(7)  # exception text contains a secret
    db.fail_select_on_call = 3  # pages 1-2 done, page 3 read fails

    code, out, err = run(db, "--apply", "--i-have-a-backup", "--batch-size", "500", capsys=capsys)
    assert code == 1
    counts = parse_counts(out)
    assert counts["updated"] == 1000 and counts["checked"] == 1000
    assert "STOPPED EARLY" in out and "RuntimeError" in err
    assert_no_secrets(out + err + logs.text, db, secrets.values())

    db.fail_select_on_call = None
    db.select_calls = 0
    code, out, err = run(db, "--apply", "--i-have-a-backup", "--batch-size", "500", capsys=capsys)
    assert code == 0, err
    counts = parse_counts(out)
    assert counts["already_hashed"] == 1000 and counts["updated"] == 1500
    assert all(v == 1 for v in db.writes_per_id.values()) and len(db.writes_per_id) == 2500
    assert run(db, "--verify", capsys=capsys)[0] == 0


def test_individual_write_failures_exit_nonzero_and_rerun_fixes_them(db, capsys, logs, fast_hash):
    secrets = big_table(db, 50)
    failing = set(list(secrets)[10:13])
    db.fail_update_ids = failing
    db.leak_bait = next(iter(secrets.values()))

    code, out, err = run(db, "--apply", "--i-have-a-backup", "--batch-size", "7", capsys=capsys)
    assert code == 1
    counts = parse_counts(out)
    assert counts["failed"] == 3 and counts["updated"] == 47 and counts["not_done_this_run"] == 3
    assert err.count("Could not update one row (RuntimeError)") == 3
    assert_no_secrets(out + err + logs.text, db, secrets.values())

    db.fail_update_ids = set()
    code, out, _ = run(db, "--apply", "--i-have-a-backup", "--batch-size", "7", capsys=capsys)
    assert code == 0
    assert parse_counts(out)["updated"] == 3
    assert all(db.writes_per_id[uid] == 1 for uid in secrets)


# ---------- Wire level: real postgrest client, mock HTTP, no network ----------


def test_real_postgrest_requests_never_carry_passwords_in_urls(capsys):
    rows = [
        {"id": f"id-{i:03d}", "password": synthetic_password(i) if i % 3 else passwords.hash_password("x" * 12)}
        for i in range(9)
    ]
    secrets = [r["password"] for r in rows if not r["password"].startswith("$argon2")]
    seen_urls, patch_bodies = [], []

    def handler(request: httpx.Request) -> httpx.Response:
        url = unquote(str(request.url))
        seen_urls.append(url)
        params = dict(parse_qsl(request.url.query.decode()))
        if request.method == "GET":
            data = sorted(rows, key=lambda r: r["id"])
            if "id" in params:
                bound = params["id"].removeprefix("gt.")
                data = [r for r in data if r["id"] > bound]
            data = data[: int(params.get("limit", len(data)))]
            return httpx.Response(200, json=[{"id": r["id"], "password": r["password"]} for r in data])
        if request.method == "PATCH":
            assert params["password"] == "not.like.$argon2%"
            target = params["id"].removeprefix("eq.")
            body = json.loads(request.content)
            patch_bodies.append(body)
            row = next(r for r in rows if r["id"] == target)
            if row["password"].startswith("$argon2"):
                return httpx.Response(200, json=[])
            row["password"] = body["password"]
            return httpx.Response(200, json=[row])
        if request.method == "POST" and request.url.path.endswith("/rpc/luma_password_guard_installed"):
            # The script must confirm the plain-text guard before writing.
            return httpx.Response(200, json=True)
        return httpx.Response(405)

    http = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://fake.invalid/rest/v1")
    client = SyncPostgrestClient("http://fake.invalid/rest/v1", http_client=http)

    code = migration.main(["--apply", "--i-have-a-backup", "--batch-size", "4"], client=client)
    out = capsys.readouterr()

    assert code == 0
    assert len(patch_bodies) == len(secrets) == 6
    assert all(r["password"].startswith("$argon2id$") for r in rows)
    for url in seen_urls:
        for secret in secrets:
            assert secret not in url
    for body in patch_bodies:
        assert set(body) == {"password"} and body["password"].startswith("$argon2id$")
    for secret in secrets:
        assert secret not in out.out + out.err


def test_apply_refuses_without_the_plaintext_guard(capsys):
    db = FakeDB()
    db.add_user(1, synthetic_password(1))
    db.guard_installed = False
    code = migration.main(["--apply", "--i-have-a-backup"], client=db)
    out = capsys.readouterr()
    assert code == 2
    assert "guard is not installed" in out.err
    assert db.tables["users"][0]["password"] == synthetic_password(1)  # nothing written


def test_dry_run_and_verify_do_not_need_the_guard():
    db = FakeDB()
    db.add_user(1, synthetic_password(1))
    db.guard_installed = False
    assert migration.main(["--dry-run"], client=db) == 0
    assert migration.main(["--verify"], client=db) == 1  # plaintext still present, so verify fails


def test_guard_check_fails_closed_when_rpc_errors():
    class Broken:
        def rpc(self, *a, **k):
            raise RuntimeError("function does not exist")

    assert migration.password_guard_installed(Broken()) is False
