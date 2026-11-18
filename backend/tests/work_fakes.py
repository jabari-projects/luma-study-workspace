"""In-memory stand-in for Supabase for the student-work tests (no network, synthetic data).

It behaves like the real tables after 2026_11_19_student_work_versions.sql:
- inserts get the column defaults (version 1, progress_rev 0 on flashcards);
- a second row with the same (user_id, create_key) raises a 23505 unique violation, like the
  partial unique index;
- one statement runs at a time (a lock), like a database.
`before_update` lets a test slip another tab's save in between a read and a write.
"""

from __future__ import annotations

import copy
import threading
import uuid
from types import SimpleNamespace
from typing import Callable, Optional

import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app import flashcards, main, notes, publishing, study_sessions, summaries
from app.auth import get_current_user, get_current_user_id

TABLE_DEFAULTS = {
    "notes": {"version": 1},
    "summaries": {"version": 1},
    "flashcards": {"version": 1, "progress_rev": 0},
    "study_sessions": {"version": 1},
}


class WorkQuery:
    def __init__(self, db: "WorkDB", table: str):
        self.db = db
        self.table_name = table
        self.op = "select"
        self.payload = None
        self.filters: list[tuple[str, object]] = []
        self.limit_n: Optional[int] = None

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

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def single(self):
        return self

    def _matches(self, row: dict) -> bool:
        return all(row.get(column) == value for column, value in self.filters)

    def execute(self):
        if self.op == "update" and self.db.before_update:
            hook = self.db.before_update
            hook(self)
        with self.db.lock:
            self.db.calls.append((self.table_name, self.op, list(self.filters), copy.deepcopy(self.payload)))
            rows = self.db.tables.setdefault(self.table_name, [])
            if self.op == "insert":
                row = {
                    "id": str(uuid.uuid4()),
                    "created_at": "2026-11-19T00:00:00+00:00",
                    **TABLE_DEFAULTS.get(self.table_name, {}),
                    **copy.deepcopy(self.payload),
                }
                key = row.get("create_key")
                if key is not None and any(
                    r.get("user_id") == row["user_id"] and r.get("create_key") == key for r in rows
                ):
                    raise APIError({"code": "23505", "message": "duplicate key value violates unique constraint"})
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
            return SimpleNamespace(data=copy.deepcopy(matched))


class WorkDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.calls: list[tuple] = []
        self.lock = threading.RLock()
        self.before_update: Optional[Callable[[WorkQuery], None]] = None

    def table(self, name):
        return WorkQuery(self, name)

    def rows(self, table: str) -> list[dict]:
        return self.tables.get(table, [])

    def row(self, table: str, item_id: str) -> dict:
        return next(row for row in self.rows(table) if row["id"] == item_id)

    def other_tab_saves(self, table: str, item_id: str, times: int = 1, **fields):
        """The next `times` updates first find that another tab already saved `fields`."""
        state = {"left": times}

        def hook(query: WorkQuery):
            if query.table_name != table or state["left"] <= 0:
                return
            state["left"] -= 1
            with self.lock:
                row = self.row(table, item_id)
                bumped = dict(fields)
                if "progress_rev" not in fields:
                    bumped["version"] = int(row.get("version") or 1) + 1
                row.update(bumped)

        self.before_update = hook


class Who:
    """The signed-in student for the test client. Change `.id` to act as someone else."""

    def __init__(self, user_id: str):
        self.id = user_id


@pytest.fixture
def work_db(monkeypatch):
    fake = WorkDB()
    monkeypatch.setattr(main, "supabase", fake)
    for module in (notes, summaries, flashcards, study_sessions, publishing):
        monkeypatch.setattr(module, "get_supabase", lambda: fake)
    return fake


@pytest.fixture
def student():
    return Who("student-a")


@pytest.fixture
def work_api(work_db, student):
    main.app.dependency_overrides[get_current_user_id] = lambda: student.id
    main.app.dependency_overrides[get_current_user] = lambda: {"id": student.id}
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(get_current_user_id, None)
        main.app.dependency_overrides.pop(get_current_user, None)


# One create body and one edit per kind of student work.
KINDS = {
    "notes": ({"title": "Cells", "content": "SYNTH cells", "tags": ["bio"]}, {"content": "SYNTH cells, edited"}),
    "summaries": ({"title": "Short", "content": "SYNTH summary"}, {"content": "SYNTH summary, edited"}),
    "flashcards": (
        {"title": "Deck", "cards": [{"id": "c1", "front": "Q1", "back": "A1"}]},
        {"title": "Deck, edited"},
    ),
    "study-sessions": ({"name": "Morning", "duration_seconds": 600}, {"name": "Morning, edited"}),
}
TABLE_OF = {"notes": "notes", "summaries": "summaries", "flashcards": "flashcards", "study-sessions": "study_sessions"}
