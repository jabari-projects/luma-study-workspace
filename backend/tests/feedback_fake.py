"""In-memory stand-in for the feedback tables and functions (no network, no database).

It mirrors the parts of 2026_11_18_monthly_feedback.sql the backend relies on:
unique keys, the guard triggers' main rules, cascades, and the three functions
(feedback_submit, feedback_save_questions, feedback_totals). The SQL itself is
proven separately on PGlite by backend/scripts/check_feedback_migration.mjs.
"""

from __future__ import annotations

import copy
import threading
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Callable

UTC = timezone.utc

# Function name -> parameter names, as declared in the migration (checked by a test).
RPC_SIGNATURES = {
    "feedback_submit": ["p_poll_id", "p_user_id", "p_voter_key", "p_answers", "p_comment", "p_urgent_flags"],
    "feedback_save_questions": ["p_poll_id", "p_labels"],
    "feedback_totals": ["p_poll_id"],
    "feedback_forget_voter_keys": [],
}

UNIQUE_KEYS = {
    "feedback_polls": [("period_month",)],
    "feedback_questions": [("poll_id", "position")],
    "feedback_responses": [("poll_id", "user_id"), ("poll_id", "voter_key")],
    "feedback_answers": [("response_id", "question_id")],
    "feedback_skips": [("poll_id", "user_id")],
    "feedback_theme_members": [("theme_id", "response_id")],
}


class FakeAPIError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _ts(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


class FakeQuery:
    def __init__(self, db: "FeedbackFake", table: str):
        self.db = db
        self.table_name = table
        self.op = "select"
        self.payload = None
        self.filters: list[tuple[str, str, object]] = []
        self.single = False
        self.start = 0
        self.limit_n = None
        self.orders: list[tuple[str, bool]] = []

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
        self.filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, tuple(values)))
        return self

    def is_(self, column, value):
        assert value == "null"
        self.filters.append(("is_null", column, None))
        return self

    def order(self, column, desc=False):
        self.orders.append((column, desc))
        return self

    def range(self, start, end):
        self.start, self.limit_n = start, end - start + 1
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def maybe_single(self):
        self.single = True
        return self

    def _match(self, row):
        for kind, column, value in self.filters:
            cell = row.get(column)
            if kind == "eq":
                same = (str(cell) == str(value)) if cell is not None and value is not None else cell == value
                if not same:
                    return False
            if kind == "in" and str(cell) not in {str(v) for v in value}:
                return False
            if kind == "is_null" and cell is not None:
                return False
        return True

    def execute(self):
        with self.db.lock:
            return self._execute()

    def _execute(self):
        db = self.db
        db.calls.append((self.table_name, self.op))
        db.check_available(self.table_name)
        if (self.table_name, self.op) in db.fail_on:
            raise FakeAPIError("XX000", "simulated database failure")
        rows = db.tables.setdefault(self.table_name, [])
        if self.op == "insert":
            payloads = self.payload if isinstance(self.payload, list) else [self.payload]
            created = []
            for payload in payloads:
                row = db.defaults(self.table_name, copy.deepcopy(payload))
                db.before_insert(self.table_name, row)
                db.check_unique(self.table_name, row, db.tables.setdefault(self.table_name, []) + created)
                created.append(row)
            rows = db.tables[self.table_name]
            rows.extend(created)
            return SimpleNamespace(data=copy.deepcopy(created))
        matched = [row for row in rows if self._match(row)]
        if self.op == "update":
            for row in matched:
                new = {**row, **copy.deepcopy(self.payload)}
                db.before_update(self.table_name, row, new)
                db.check_unique(self.table_name, new, [r for r in rows if r is not row])
                db.after_update(self.table_name, row, new)
                row.clear()
                row.update(new)
            return SimpleNamespace(data=copy.deepcopy(matched))
        if self.op == "delete":
            for row in matched:
                db.before_delete(self.table_name, row)
            for row in matched:
                rows.remove(row)
                db.cascade(self.table_name, row)
            return SimpleNamespace(data=copy.deepcopy(matched))
        for column, desc in reversed(self.orders):
            matched.sort(key=lambda r: (r.get(column) is None, str(r.get(column))), reverse=desc)
        matched = matched[self.start:]
        if self.limit_n is not None:
            matched = matched[: self.limit_n]
        if self.single:
            return SimpleNamespace(data=copy.deepcopy(matched[0])) if matched else None
        return SimpleNamespace(data=copy.deepcopy(matched))


class FeedbackFake:
    def __init__(self, now: Callable[[], datetime]):
        self.now = now
        self.tables: dict[str, list[dict]] = {"users": []}
        self.calls: list[tuple] = []
        self.fail_on: set[tuple[str, str]] = set()
        self.missing: set[str] = set()
        self.rpc_hook = None  # optional callable(name, params) run before an rpc
        self.lock = threading.RLock()

    # ---------------- helpers for tests
    def user(self, email="student@example.com", verified=True, role=None, user_id=None):
        row = {"id": user_id or str(uuid.uuid4()), "email": email, "email_verified": verified, "role": role}
        self.tables["users"].append(row)
        return row

    def rows(self, table):
        return self.tables.setdefault(table, [])

    def check_available(self, name):
        if name in self.missing:
            code = "PGRST202" if name.startswith("feedback_") and name in RPC_SIGNATURES else "PGRST205"
            raise FakeAPIError(code, f"Could not find the table public.{name}")

    # ---------------- table behaviour
    def table(self, name):
        return FakeQuery(self, name)

    def defaults(self, table, row):
        now = self.now().isoformat()
        if table in ("feedback_polls", "feedback_questions", "feedback_responses", "feedback_comment_themes", "feedback_admin_updates"):
            row.setdefault("id", str(uuid.uuid4()))
        if table == "feedback_polls":
            row.setdefault("approved_at", None)
            row.setdefault("created_at", now)
        if table == "feedback_responses":
            row.setdefault("comment", None)
            row.setdefault("urgent_flags", [])
            row.setdefault("urgent_set_by_admin", False)
            row.setdefault("submitted_at", now)
        if table in ("feedback_comment_themes", "feedback_admin_updates", "feedback_skips"):
            row.setdefault("created_at", now)
        if table == "feedback_admin_updates":
            row.setdefault("position", 1)
            row.setdefault("status", "reviewing")
            row.setdefault("note", None)
            row.setdefault("published", False)
        return row

    def check_unique(self, table, row, others):
        for key in UNIQUE_KEYS.get(table, []):
            values = tuple(row.get(c) for c in key)
            if any(v is None for v in values):
                continue
            for other in others:
                if tuple(other.get(c) for c in key) == values:
                    raise FakeAPIError("23505", f"duplicate key value violates unique constraint ({','.join(key)})")
        if table == "feedback_comment_themes" and row.get("source") == "auto":
            for other in others:
                if other.get("source") == "auto" and other.get("poll_id") == row.get("poll_id") and other.get("term") == row.get("term"):
                    raise FakeAPIError("23505", "duplicate auto term")

    def _poll(self, poll_id):
        return next((p for p in self.rows("feedback_polls") if str(p["id"]) == str(poll_id)), None)

    def _overlap(self, row):
        if row.get("approved_at") is None:
            return
        o, c = _ts(row["opens_at"]), _ts(row["closes_at"])
        for other in self.rows("feedback_polls"):
            if other["id"] == row["id"] or other.get("approved_at") is None:
                continue
            if o < _ts(other["closes_at"]) and _ts(other["opens_at"]) < c:
                raise FakeAPIError("23P01", "conflicting key value violates exclusion constraint")

    def before_insert(self, table, row):
        if table == "feedback_polls":
            if row.get("approved_at") is not None:
                raise FakeAPIError("P0001", "insert_as_draft")
            if _ts(row["closes_at"]) <= _ts(row["opens_at"]):
                raise FakeAPIError("23514", "feedback_polls_window")
        if table == "feedback_questions":
            poll = self._poll(row["poll_id"])
            if poll and poll.get("approved_at") is not None:
                raise FakeAPIError("P0001", "wording_locked")
        if table == "feedback_responses":
            if row.get("user_id") is None or row.get("voter_key") is None:
                raise FakeAPIError("P0001", "ballot_needs_voter")
            poll = self._poll(row["poll_id"])
            now = self.now()
            if poll is None or poll.get("approved_at") is None or now < _ts(poll["opens_at"]):
                raise FakeAPIError("P0001", "poll_not_open")
            if now >= _ts(poll["closes_at"]):
                raise FakeAPIError("P0001", "poll_closed")
            comment = row.get("comment")
            if comment is not None and not (1 <= len(comment) <= 500):
                raise FakeAPIError("23514", "feedback_responses_comment_check")
        if table == "feedback_admin_updates" and row.get("status") not in ("reviewing", "planned", "keeping", "done"):
            raise FakeAPIError("23514", "status check")

    def before_update(self, table, old, new):
        now = self.now()
        if table == "feedback_polls":
            if old.get("approved_at") is not None and _ts(old["opens_at"]) <= now:
                if (new["opens_at"], new["closes_at"], new.get("approved_at")) != (old["opens_at"], old["closes_at"], old.get("approved_at")):
                    raise FakeAPIError("P0001", "wording_locked")
            if new.get("approved_at") is not None and (old.get("approved_at") is None or new["opens_at"] != old["opens_at"]):
                if _ts(new["opens_at"]) <= now:
                    raise FakeAPIError("P0001", "opens_in_past")
            if new.get("approved_at") is not None and old.get("approved_at") is None:
                if not [q for q in self.rows("feedback_questions") if q["poll_id"] == new["id"]]:
                    raise FakeAPIError("P0001", "no_questions")
            if _ts(new["closes_at"]) <= _ts(new["opens_at"]):
                raise FakeAPIError("23514", "feedback_polls_window")
            self._overlap(new)
        if table == "feedback_responses":
            for col in ("id", "poll_id", "submitted_at"):
                if new.get(col) != old.get(col):
                    raise FakeAPIError("P0001", "ballot_immutable")
            if new.get("voter_key") != old.get("voter_key"):
                if new.get("voter_key") is not None:
                    raise FakeAPIError("P0001", "ballot_immutable")
                poll = self._poll(new["poll_id"])
                if new.get("user_id") is not None or poll is None or now < _ts(poll["closes_at"]):
                    raise FakeAPIError("P0001", "voter_key_in_use")
            if new.get("user_id") != old.get("user_id") and new.get("user_id") is not None:
                raise FakeAPIError("P0001", "ballot_immutable")
            if new.get("comment") != old.get("comment") and new.get("comment") is not None:
                raise FakeAPIError("P0001", "ballot_immutable")
            if old.get("user_id") is not None and new.get("user_id") is None:
                new["comment"] = None
                new["urgent_flags"] = []
                new["urgent_set_by_admin"] = False
        if table == "feedback_answers":
            raise FakeAPIError("P0001", "ballot_immutable")
        if table == "feedback_questions":
            poll = self._poll(old["poll_id"])
            if poll and poll.get("approved_at") is not None:
                raise FakeAPIError("P0001", "wording_locked")

    def after_update(self, table, old, new):
        if table == "feedback_responses" and old.get("comment") is not None and new.get("comment") is None:
            self.tables["feedback_theme_members"] = [
                m for m in self.rows("feedback_theme_members") if m["response_id"] != new["id"]
            ]

    def before_delete(self, table, row):
        if table == "feedback_polls" and row.get("approved_at") is not None:
            raise FakeAPIError("P0001", "wording_locked")
        if table == "feedback_questions":
            poll = self._poll(row["poll_id"])
            if poll and poll.get("approved_at") is not None:
                raise FakeAPIError("P0001", "wording_locked")
        if table == "feedback_responses":
            raise FakeAPIError("42501", "permission denied for table feedback_responses")
        if table == "feedback_answers":
            raise FakeAPIError("42501", "permission denied for table feedback_answers")

    def cascade(self, table, row):
        if table == "feedback_comment_themes":
            self.tables["feedback_theme_members"] = [m for m in self.rows("feedback_theme_members") if m["theme_id"] != row["id"]]
        if table == "users":
            for r in self.rows("feedback_responses"):
                if r.get("user_id") == row["id"]:
                    new = {**r, "user_id": None}
                    self.before_update("feedback_responses", r, new)
                    self.after_update("feedback_responses", r, new)
                    r.update(new)
            self.tables["feedback_skips"] = [s for s in self.rows("feedback_skips") if s["user_id"] != row["id"]]

    # ---------------- functions
    def rpc(self, name, params=None):
        params = params or {}

        def execute():
            with self.lock:
                self.calls.append((name, "rpc"))
                self.check_available(name)
                if name not in RPC_SIGNATURES:
                    raise FakeAPIError("PGRST202", f"Could not find the function public.{name}")
                assert sorted(params) == sorted(RPC_SIGNATURES[name]), (name, sorted(params))
                if self.rpc_hook:
                    self.rpc_hook(name, params)
                return SimpleNamespace(data=getattr(self, "_rpc_" + name)(**params))

        return SimpleNamespace(execute=execute)

    def _find_ballot(self, poll_id, user_id, key):
        for r in sorted(self.rows("feedback_responses"), key=lambda r: r["submitted_at"]):
            if r["poll_id"] == poll_id and (r.get("user_id") == user_id or r.get("voter_key") == key):
                return r
        return None

    def _rpc_feedback_submit(self, p_poll_id, p_user_id, p_voter_key, p_answers, p_comment, p_urgent_flags):
        existing = self._find_ballot(p_poll_id, p_user_id, p_voter_key)
        if existing:
            return [{"response_id": existing["id"], "created": False, "received_at": existing["submitted_at"]}]
        user = next((u for u in self.rows("users") if u["id"] == p_user_id), None)
        if not user or user.get("email_verified") is not True:
            raise FakeAPIError("P0001", "email_unverified")
        row = self.defaults(
            "feedback_responses",
            {"poll_id": p_poll_id, "user_id": p_user_id, "voter_key": p_voter_key, "comment": p_comment or None,
             "urgent_flags": list(p_urgent_flags or [])},
        )
        self.before_insert("feedback_responses", row)
        self.check_unique("feedback_responses", row, self.rows("feedback_responses"))
        answers = []
        poll_questions = {q["id"] for q in self.rows("feedback_questions") if q["poll_id"] == p_poll_id}
        seen = set()
        for a in p_answers or []:
            if a["question_id"] not in poll_questions:
                raise FakeAPIError("23503", "feedback_answers question fk")
            if a["question_id"] in seen:
                raise FakeAPIError("23505", "feedback_answers_pkey")
            if not isinstance(a["wants_change"], bool):
                raise FakeAPIError("22P02", "invalid input syntax for type boolean")
            seen.add(a["question_id"])
            answers.append({"response_id": row["id"], "poll_id": p_poll_id, "question_id": a["question_id"], "wants_change": a["wants_change"]})
        self.rows("feedback_responses").append(row)
        self.rows("feedback_answers").extend(answers)
        return [{"response_id": row["id"], "created": True, "received_at": row["submitted_at"]}]

    def _rpc_feedback_forget_voter_keys(self):
        now = self.now()
        count = 0
        for r in self.rows("feedback_responses"):
            poll = self._poll(r["poll_id"])
            if r.get("user_id") is None and r.get("voter_key") is not None and poll and _ts(poll["closes_at"]) <= now:
                r["voter_key"] = None
                count += 1
        return count

    def _rpc_feedback_save_questions(self, p_poll_id, p_labels):
        poll = self._poll(p_poll_id)
        if poll is None or poll.get("approved_at") is not None:
            raise FakeAPIError("P0001", "wording_locked")
        labels = [str(label).strip() for label in p_labels]
        if any(not 3 <= len(label) <= 160 for label in labels):
            raise FakeAPIError("23514", "feedback_questions_label_check")
        self.tables["feedback_questions"] = [q for q in self.rows("feedback_questions") if q["poll_id"] != p_poll_id]
        for i, label in enumerate(labels, start=1):
            self.rows("feedback_questions").append({"id": str(uuid.uuid4()), "poll_id": p_poll_id, "position": i, "label": label})
        return len(labels)

    def _rpc_feedback_totals(self, p_poll_id):
        participants = len([r for r in self.rows("feedback_responses") if r["poll_id"] == p_poll_id])
        out = []
        for q in sorted((q for q in self.rows("feedback_questions") if q["poll_id"] == p_poll_id), key=lambda q: q["position"]):
            answers = [a for a in self.rows("feedback_answers") if a["question_id"] == q["id"]]
            out.append({
                "question_id": q["id"], "position": q["position"], "label": q["label"],
                "yes_count": sum(1 for a in answers if a["wants_change"]),
                "no_count": sum(1 for a in answers if not a["wants_change"]),
                "participants": participants,
            })
        return out
