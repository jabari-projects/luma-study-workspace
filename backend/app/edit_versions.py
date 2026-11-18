"""Safe saves for student work: version checks and retry-safe creates.

Used by notes.py, summaries.py, flashcards.py and study_sessions.py. Needs the additive
migration 2026_11_19_student_work_versions.sql (columns version, create_key, progress_rev).

- Creates: the browser sends `Idempotency-Key: <uuid>`. It is stored as `create_key`, with a
  unique index on (user_id, create_key). A retried create whose first copy already landed hits
  that index (23505) and gets the first row back (200 + `Idempotent-Replay: true`) instead of a
  second copy. The index is per student, so another student's key never matches.
- Updates: the browser sends `expected_version`. The update only lands if the row still has
  that version (compare-and-swap: `.eq("version", v)`), and it sets `version = v + 1`. If the
  row moved on, the answer is 409 `edit_conflict` with the newer row, unless the stored row
  already holds exactly what was sent (a retried request whose first copy landed): then 200.
"""

from __future__ import annotations

import functools
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastapi import HTTPException, Response, status
from fastapi.responses import JSONResponse


logger = logging.getLogger(__name__)

IDEMPOTENCY_HEADER = "Idempotency-Key"
REPLAY_HEADER = "Idempotent-Replay"
MAX_CAS_ROUNDS = 3
CONFLICT_DETAIL = "This was changed in another tab or on another device."
BAD_KEY_DETAIL = "That save key isn't valid. Please reload Luma and try again."
PROGRESS_BUSY_DETAIL = "Your progress is being saved from another tab. Trying again."
UNIQUE_VIOLATION = "23505"


class WorkResponse(Exception):
    """A finished error answer (exact JSON body) from deep inside a save."""

    def __init__(self, status_code: int, body: dict):
        super().__init__(body.get("error_code") or status_code)
        self.response = JSONResponse(status_code=status_code, content=body)


def work_route(fn: Callable) -> Callable:
    """Turns a WorkResponse raised by the route into its JSON answer (FastAPI keeps the signature)."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except WorkResponse as answer:
            return answer.response

    return wrapper


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def row_version(row: dict) -> int:
    value = row.get("version")
    return int(value) if value is not None else 1


def parse_idempotency_key(raw: Optional[str]) -> Optional[str]:
    """None when the header is missing (an older cached frontend). 422 when it isn't a uuid."""
    if raw is None:
        return None
    try:
        return str(uuid.UUID(raw.strip()))
    except (ValueError, AttributeError):
        raise WorkResponse(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"detail": BAD_KEY_DETAIL, "error_code": "bad_idempotency_key"},
        )


def is_unique_violation(exc: Exception) -> bool:
    return getattr(exc, "code", None) == UNIQUE_VIOLATION


def gone(detail: str) -> WorkResponse:
    return WorkResponse(status.HTTP_404_NOT_FOUND, {"detail": detail, "error_code": "item_gone"})


def conflict(current: dict) -> WorkResponse:
    return WorkResponse(
        status.HTTP_409_CONFLICT,
        {"detail": CONFLICT_DETAIL, "error_code": "edit_conflict", "current": current},
    )


def load_row(db: Any, table: str, user_id: str, item_id: str) -> Optional[dict]:
    rows = (
        db
        .table(table)
        .select("*")
        .eq("id", item_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


def idempotent_insert(
    db: Any,
    table: str,
    user_id: str,
    values: dict,
    create_key: Optional[str],
    response: Response,
    failure_detail: str,
) -> dict:
    """Insert one row. With a key, a repeat of the same create returns the first row (200)."""
    row = {**values, "user_id": user_id}
    if create_key:
        row["create_key"] = create_key
    try:
        rows = db.table(table).insert(row).execute().data or []
    except Exception as exc:
        if not (create_key and is_unique_violation(exc)):
            raise
        existing = (
            db
            .table(table)
            .select("*")
            .eq("user_id", user_id)
            .eq("create_key", create_key)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not existing:
            raise
        response.status_code = status.HTTP_200_OK
        response.headers[REPLAY_HEADER] = "true"
        return existing[0]
    if not rows:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=failure_detail)
    response.status_code = status.HTTP_201_CREATED
    return rows[0]


def cas_update(
    db: Any,
    *,
    table: str,
    user_id: str,
    item_id: str,
    expected_version: Optional[int],
    prepare: Callable[[dict], dict],
    already_applied: Callable[[dict], bool],
    normalize: Callable[[dict], dict],
    missing_detail: str,
    extra_match: Callable[[dict], dict[str, Any]] = lambda row: {},
) -> dict:
    """Update one row only if nobody else saved first. Returns the stored row.

    `db` is the Supabase client the router uses (passed in so tests can swap it).

    `prepare(row)` builds the update from the row it was read from (it may raise a 400/422).
    `already_applied(row)` is True when the stored row already holds what the request sends.
    `extra_match(row)` adds more compare-and-swap conditions (flashcards: progress_rev).
    """
    for _ in range(MAX_CAS_ROUNDS):
        row = load_row(db, table, user_id, item_id)
        if row is None:
            raise gone(missing_detail)
        current = row_version(row)
        if expected_version is not None and expected_version != current:
            if already_applied(row):
                return row
            raise conflict(normalize(row))
        # OVERLAP(remove after the frontend with expected_version is live): with no
        # expected_version this is last-write-wins (what browsers that loaded the old frontend
        # send during a deploy), but the version still goes up so new tabs see the change.
        updates = {**prepare(row), "version": current + 1, "updated_at": utc_now_iso()}
        query = (
            db
            .table(table)
            .update(updates)
            .eq("id", item_id)
            .eq("user_id", user_id)
            .eq("version", current)
        )
        for column, value in extra_match(row).items():
            query = query.eq(column, value)
        rows = query.execute().data or []
        if rows:
            return rows[0]
        # Someone saved between our read and our write: read again and decide again.
    row = load_row(db, table, user_id, item_id)
    if row is None:
        raise gone(missing_detail)
    logger.info("Save lost %s compare-and-swap rounds table=%s", MAX_CAS_ROUNDS, table)
    raise conflict(normalize(row))


def fields_match(row: dict, sent: dict, fields: tuple[str, ...]) -> bool:
    """True when every field the request sends already has that value in the stored row."""
    present = [field for field in fields if field in sent]
    return bool(present) and all(_same(row.get(field), sent[field]) for field in present)


def _same(stored: Any, sent: Any) -> bool:
    if isinstance(sent, list) and stored is None:
        return sent == []
    if isinstance(sent, str) and stored is None:
        return sent == ""
    return stored == sent
