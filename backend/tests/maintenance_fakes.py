"""In-memory stand-ins for the maintenance tests. Synthetic data only; nothing touches a network.

FakeMaintenanceDB mimics the few supabase-py query shapes MaintenanceStore uses, so the real
store code runs in the tests. One FakeMaintenanceDB can be shared by several
MaintenanceRuntime objects: that is how two server instances (or a restarted one) are
simulated.
"""

from __future__ import annotations

import copy
import threading
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app import maintenance

TABLE_COLUMNS = {
    **{name: set(cols) for name, cols in maintenance.REQUIRED_SCHEMA.items()},
    "users": {"id", "email", "role"},
    "profiles": {"user_id", "username"},
    "notes": {"id", "user_id", "title", "version", "create_key"},
    "summaries": {"id", "user_id", "version", "create_key"},
    "flashcards": {"id", "user_id", "version", "create_key", "progress_rev"},
    "study_sessions": {"id", "user_id", "version", "create_key"},
}


class FakeClock:
    def __init__(self, start: datetime | None = None):
        self.now = start or datetime(2026, 12, 1, 10, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta) -> None:
        self.now = self.now + timedelta(**delta)


class _Query:
    def __init__(self, db: "FakeMaintenanceDB", table: str):
        self.db = db
        self.table = table
        self.op = "select"
        self.payload = None
        self.filters: list[tuple[str, object]] = []
        self.columns = "*"
        self.count_mode = None
        self.head = False
        self.limit_n = None
        self.order_by = None
        self.single_row = False
        self.on_conflict = None

    def select(self, columns="*", count=None, head=None):
        self.op, self.columns, self.count_mode, self.head = "select", columns, count, bool(head)
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def upsert(self, payload, on_conflict=None):
        self.op, self.payload, self.on_conflict = "upsert", payload, on_conflict
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def order(self, column, desc=False):
        self.order_by = (column, desc)
        return self

    def maybe_single(self):
        # Like supabase-py: one row as a dict, or None when nothing matched.
        self.single_row = True
        return self

    def _match(self, row):
        return all(row.get(c) == v for c, v in self.filters)

    def execute(self):
        with self.db.lock:
            return self._execute()

    def _execute(self):
        db = self.db
        db.calls.append((self.table, self.op))
        if self.table in db.fail_tables or (self.table, self.op) in db.fail_ops:
            raise RuntimeError("simulated database failure")
        if self.table not in TABLE_COLUMNS or self.table in db.missing_tables:
            raise RuntimeError("relation does not exist")
        rows = db.tables.setdefault(self.table, [])
        if self.op == "select" and self.columns not in ("*", ""):
            wanted = {c.strip() for c in self.columns.split(",")}
            unknown = wanted - TABLE_COLUMNS[self.table]
            if unknown:
                raise RuntimeError("column does not exist")
        if self.op == "insert":
            row = copy.deepcopy(self.payload)
            if self.table == maintenance.LOG_TABLE:
                row.setdefault("id", str(uuid.uuid4()))
            if self.table == maintenance.JOBS_TABLE and any(r["job_id"] == row["job_id"] for r in rows):
                raise RuntimeError("duplicate key")
            rows.append(row)
            return SimpleNamespace(data=[copy.deepcopy(row)], count=None)
        if self.op == "upsert":
            key = self.on_conflict
            for row in rows:
                if row.get(key) == self.payload.get(key):
                    row.update(copy.deepcopy(self.payload))
                    return SimpleNamespace(data=[copy.deepcopy(row)], count=None)
            rows.append(copy.deepcopy(self.payload))
            return SimpleNamespace(data=[copy.deepcopy(self.payload)], count=None)
        matched = [row for row in rows if self._match(row)]
        if self.op == "update":
            for row in matched:
                row.update(copy.deepcopy(self.payload))
            return SimpleNamespace(data=copy.deepcopy(matched), count=None)
        if self.op == "delete":
            for row in matched:
                rows.remove(row)
            return SimpleNamespace(data=copy.deepcopy(matched), count=None)
        if self.order_by:
            column, desc = self.order_by
            matched = sorted(matched, key=lambda r: str(r.get(column) or ""), reverse=desc)
        count = len(matched) if self.count_mode == "exact" else None
        if self.head:
            return SimpleNamespace(data=[], count=count)
        if self.limit_n is not None:
            matched = matched[: self.limit_n]
        if self.single_row:
            return SimpleNamespace(data=copy.deepcopy(matched[0]) if matched else None, count=count)
        return SimpleNamespace(data=copy.deepcopy(matched), count=count)


class _Bucket:
    def __init__(self, name):
        self.name = name


class _Storage:
    def __init__(self, db):
        self.db = db

    def list_buckets(self):
        if self.db.storage_fails:
            raise RuntimeError("storage down")
        return [_Bucket("avatars"), _Bucket("themes")]


class FakeMaintenanceDB:
    """The shared database both simulated instances talk to."""

    def __init__(self, seed_state: bool = True):
        self.lock = threading.RLock()
        self.tables: dict[str, list[dict]] = {name: [] for name in TABLE_COLUMNS}
        self.calls: list[tuple[str, str]] = []
        self.fail_tables: set[str] = set()
        self.fail_ops: set[tuple[str, str]] = set()
        self.missing_tables: set[str] = set()
        self.storage_fails = False
        self.storage = _Storage(self)
        if seed_state:
            self.tables[maintenance.STATE_TABLE].append({**maintenance.STATE_DEFAULTS, "rev": 1})
        # Synthetic people and work (made-up ids, @example.test only).
        self.tables["users"] = [
            {"id": "student-1", "email": "one@example.test", "role": "user"},
            {"id": "admin-1", "email": "admin@example.test", "role": "admin"},
        ]
        self.tables["profiles"] = [{"user_id": "student-1", "username": "one"}, {"user_id": "admin-1", "username": "admin"}]
        self.tables["notes"] = [{"id": f"n{i}", "user_id": "student-1", "title": f"SYNTH note {i}"} for i in range(3)]
        self.tables["summaries"] = [{"id": "s1", "user_id": "student-1"}]
        self.tables["flashcards"] = [{"id": "f1", "user_id": "student-1"}]
        self.tables["study_sessions"] = []

    def table(self, name):
        return _Query(self, name)

    @property
    def state(self) -> dict:
        return self.tables[maintenance.STATE_TABLE][0]

    def writes(self) -> list[tuple[str, str]]:
        return [c for c in self.calls if c[1] != "select"]


def make_runtime(db: FakeMaintenanceDB, clock: FakeClock, instance_id: str) -> maintenance.MaintenanceRuntime:
    store = maintenance.MaintenanceStore(client_getter=lambda: db, configured=lambda: True)
    return maintenance.MaintenanceRuntime(store=store, instance_id=instance_id, clock=clock, code_version="test-commit")


# ------------------------------------------------------------------ shared fixtures
# Imported by the test_maintenance_*.py files (conftest.py belongs to no track).

import pytest  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import auth as auth_module  # noqa: E402
from app import main  # noqa: E402
from app.auth import get_current_user_id  # noqa: E402

ADMIN_ID = "admin-1"
STUDENT_ID = "student-1"
SITE = "https://lumastudyhub.com"


class World(SimpleNamespace):
    """One shared fake database, a fake clock, and the current instance (runtime)."""

    def as_admin(self) -> TestClient:
        self.who["id"] = ADMIN_ID
        return self.client

    def as_student(self) -> TestClient:
        self.who["id"] = STUDENT_ID
        return self.client

    def signed_out(self) -> TestClient:
        self.who["id"] = None
        return self.client

    def rev(self) -> int:
        return int(self.db.state["rev"])

    def switch_instance(self, instance_id: str) -> maintenance.MaintenanceRuntime:
        runtime = make_runtime(self.db, self.clock, instance_id)
        maintenance.set_runtime(runtime)
        self.rt = runtime
        return runtime

    # ---- admin steps (each returns the response)
    def schedule(self, reason="website_update", start="2026-12-01T05:00", end="2026-12-01T06:00", note=""):
        return self.as_admin().post(
            "/admin/maintenance/schedule",
            json={"expected_rev": self.rev(), "start_local": start, "estimated_end_local": end, "reason": reason, "note": note},
        )

    def drain(self, grace_minutes=5):
        return self.as_admin().post("/admin/maintenance/drain", json={"expected_rev": self.rev(), "grace_minutes": grace_minutes})

    def activate(self, **extra):
        return self.as_admin().post("/admin/maintenance/activate", json={"expected_rev": self.rev(), **extra})

    def checks(self, **extra):
        return self.as_admin().post("/admin/maintenance/checks", json={"expected_rev": self.rev(), **extra})

    def reopen(self):
        return self.as_admin().post("/admin/maintenance/reopen", json={"expected_rev": self.rev()})

    def to_draining(self, reason="website_update"):
        assert self.schedule(reason=reason).status_code == 200
        assert self.drain().status_code == 200

    def to_active(self, reason="website_update"):
        self.to_draining(reason)
        self.clock.advance(minutes=6)
        extra = {"backup_ref": "20261201T103000Z", "backup_checked": True} if reason == "database_update" else {}
        response = self.activate(**extra)
        assert response.status_code == 200, response.text
        return response

    def to_checking(self):
        self.to_active()
        response = self.checks()
        assert response.status_code == 200, response.text
        return response


@pytest.fixture
def world(monkeypatch):
    db = FakeMaintenanceDB()
    clock = FakeClock()
    runtime = make_runtime(db, clock, "instance-a")
    maintenance.set_runtime(runtime)
    # require_admin reads users.role through app.auth.get_supabase: give it the fake database.
    monkeypatch.setattr(auth_module, "get_supabase", lambda: db)
    who = {"id": None}

    def current_user_id():
        if who["id"] is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return who["id"]

    main.app.dependency_overrides[get_current_user_id] = current_user_id
    w = World(db=db, clock=clock, rt=runtime, who=who, client=TestClient(main.app))
    try:
        yield w
    finally:
        main.app.dependency_overrides.pop(get_current_user_id, None)
        maintenance.set_runtime(None)


def gate_app(w: World):
    """A tiny app with only the maintenance gate (and CORS outside it, as in main.py).
    One catch-all route records what it saw while it ran."""
    app = FastAPI()
    seen: dict = {}

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def anything(path: str, request: Request):
        seen["in_flight"] = w.rt.in_flight
        seen["jobs"] = [dict(r) for r in w.db.tables[maintenance.JOBS_TABLE]]
        return {"ok": True, "path": "/" + path}

    app.add_middleware(maintenance.MaintenanceMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[SITE],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Luma-Maintenance", "X-Luma-Maintenance-Rev", "Retry-After", "X-Request-ID"],
    )
    return TestClient(app), seen
