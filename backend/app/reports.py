"""Reports about public study content, and the admin review queue.

- Any logged-in student can report a PUBLIC note, deck or summary.
- A report never reaches the author and never changes the item by itself.
- Admins (users.role = 'admin') see open reports and mark them reviewing,
  resolved or dismissed. Unpublishing an item stays a separate, manual step.
- Nothing is emailed or sent outside Luma; an external support inbox is a
  later, owner-approved decision.

Storage: public.content_reports (see
schemas/migrations/2026_11_17_content_reports.sql).
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .auth import get_current_user_id, require_admin
from .rate_limits import SlidingWindowLimiter
from .supabase_client import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

TABLE = "content_reports"
ITEM_TABLES = {"note": "notes", "flashcards": "flashcards", "summary": "summaries"}
REASONS = ("bullying", "unsafe", "private_info", "spam", "copyright", "wrong_info", "other")
STATUSES = ("open", "reviewing", "resolved", "dismissed")

REPORTS_PER_USER_PER_HOUR = 10
report_user_limiter = SlidingWindowLimiter(REPORTS_PER_USER_PER_HOUR, 60 * 60)

THANKS_MESSAGE = "Thanks. A Luma helper will look at this."
NOT_FOUND_MESSAGE = "We couldn't find that public item. It may have been removed."
TOO_MANY_MESSAGE = "You sent a lot of reports. Try again later."


class ReportCreate(BaseModel):
    item_type: Literal["note", "flashcards", "summary"]
    item_id: str = Field(..., min_length=1, max_length=64)
    reason: Literal["bullying", "unsafe", "private_info", "spam", "copyright", "wrong_info", "other"]
    details: Optional[str] = Field(default=None, max_length=500)


class ReportCreated(BaseModel):
    success: bool
    message: str


class ReportOut(BaseModel):
    id: str
    item_type: str
    item_id: str
    item_title: Optional[str] = None
    reason: str
    details: Optional[str] = None
    status: str
    created_at: Optional[str] = None
    reviewed_at: Optional[str] = None
    reviewer_note: Optional[str] = None


class ReportUpdate(BaseModel):
    status: Literal["reviewing", "resolved", "dismissed", "open"]
    reviewer_note: Optional[str] = Field(default=None, max_length=500)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _rows(response) -> list:
    return list(getattr(response, "data", None) or [])


def _public_item(item_type: str, item_id: str) -> Optional[dict]:
    table = ITEM_TABLES[item_type]
    rows = _rows(
        get_supabase().table(table).select("id, title, is_public").eq("id", item_id).limit(1).execute()
    )
    if not rows or rows[0].get("is_public") is not True:
        return None
    return rows[0]


@router.post("/public/reports", response_model=ReportCreated, status_code=201)
def create_report(payload: ReportCreate, request: Request, user_id: str = Depends(get_current_user_id)):
    if not report_user_limiter.hit(user_id):
        return JSONResponse(status_code=429, content={"detail": TOO_MANY_MESSAGE, "error_code": "rate_limited"})
    try:
        item = _public_item(payload.item_type, payload.item_id)
    except Exception as exc:  # noqa: BLE001 - bad id format or database trouble
        logger.warning("Report lookup failed (%s)", type(exc).__name__)
        item = None
    if item is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND_MESSAGE)

    db = get_supabase()
    existing = _rows(
        db.table(TABLE)
        .select("id")
        .eq("reporter_id", user_id)
        .eq("item_type", payload.item_type)
        .eq("item_id", payload.item_id)
        .eq("status", "open")
        .limit(1)
        .execute()
    )
    if existing:
        # Same student, same item, still open: don't pile up duplicates.
        return {"success": True, "message": THANKS_MESSAGE}

    details = (payload.details or "").strip() or None
    db.table(TABLE).insert(
        {
            "id": str(uuid.uuid4()),
            "item_type": payload.item_type,
            "item_id": payload.item_id,
            "item_title": (item.get("title") or "")[:200] or None,
            "reason": payload.reason,
            "details": details,
            "reporter_id": user_id,
            "status": "open",
            "created_at": _now(),
        }
    ).execute()
    logger.info("Content report created type=%s reason=%s", payload.item_type, payload.reason)
    return {"success": True, "message": THANKS_MESSAGE}


@router.get("/admin/reports", response_model=list[ReportOut])
def list_reports(
    status: Literal["open", "reviewing", "resolved", "dismissed", "all"] = "open",
    _admin: str = Depends(require_admin),
):
    query = get_supabase().table(TABLE).select("*").order("created_at", desc=True).limit(200)
    if status != "all":
        query = query.eq("status", status)
    rows = _rows(query.execute())
    # Never expose who reported, even to admins in the list (it isn't needed to review).
    return [{k: v for k, v in row.items() if k != "reporter_id"} for row in rows]


@router.patch("/admin/reports/{report_id}", response_model=ReportOut)
def update_report(report_id: str, payload: ReportUpdate, _admin: str = Depends(require_admin)):
    changes = {"status": payload.status, "reviewed_at": _now() if payload.status != "open" else None}
    if payload.reviewer_note is not None:
        changes["reviewer_note"] = payload.reviewer_note.strip() or None
    rows = _rows(get_supabase().table(TABLE).update(changes).eq("id", report_id).execute())
    if not rows:
        raise HTTPException(status_code=404, detail="Report not found")
    return {k: v for k, v in rows[0].items() if k != "reporter_id"}
