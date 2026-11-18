from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from pydantic import BaseModel, Field

from .auth import get_current_user_id
from .edit_versions import (
    IDEMPOTENCY_HEADER,
    cas_update,
    fields_match,
    idempotent_insert,
    parse_idempotency_key,
    row_version,
    utc_now_iso,
    work_route,
)
from .publishing import strip_client_publish_fields
from .supabase_client import get_supabase

router = APIRouter(prefix="/study-sessions", tags=["study_sessions"])
TABLE_NAME = "study_sessions"
# What a student edits. A retried save whose first copy landed already matches on these.
EDIT_FIELDS = ("name", "subject", "notes", "duration_seconds")


class StudySessionCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    subject: Optional[str] = Field(default=None, max_length=200)
    notes: Optional[str] = None
    duration_seconds: int = Field(default=0, ge=0)
    # Accepted so older frontends keep working, but ignored: the server sets the time.
    updated_at: Optional[str] = None


class StudySessionUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    subject: Optional[str] = Field(default=None, max_length=200)
    notes: Optional[str] = None
    duration_seconds: Optional[int] = Field(default=None, ge=0)
    updated_at: Optional[str] = None
    # The version the page loaded. Missing only from browsers still on the old frontend.
    expected_version: Optional[int] = Field(default=None, ge=1)


class StudySessionResponse(BaseModel):
    id: str
    user_id: str
    name: str
    subject: Optional[str] = None
    notes: Optional[str] = None
    duration_seconds: int
    created_at: str
    updated_at: Optional[str] = None
    version: int = 1


class StudySessionDeleteResponse(BaseModel):
    message: str


def _normalize_study_session_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "name": row.get("name") or "",
        "subject": row.get("subject"),
        "notes": row.get("notes"),
        "duration_seconds": row.get("duration_seconds") or 0,
        "created_at": row["created_at"],
        "updated_at": row.get("updated_at"),
        "version": row_version(row),
    }


def _get_study_session_or_404(user_id: str, session_id: str) -> dict:
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("id", session_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Study session not found")
    return rows[0]


@router.post("", response_model=StudySessionResponse, status_code=status.HTTP_201_CREATED)
@work_route
def create_study_session(
    payload: StudySessionCreateRequest,
    response: Response,
    user_id: str = Depends(get_current_user_id),
    idempotency_key: Optional[str] = Header(default=None, alias=IDEMPOTENCY_HEADER),
):
    row = idempotent_insert(
        get_supabase(),
        TABLE_NAME,
        user_id,
        {
            "name": payload.name,
            "subject": payload.subject,
            "notes": payload.notes,
            "duration_seconds": payload.duration_seconds,
            "updated_at": utc_now_iso(),
        },
        parse_idempotency_key(idempotency_key),
        response,
        "Failed to create study session",
    )
    return _normalize_study_session_row(row)


@router.get("", response_model=list[StudySessionResponse])
def list_study_sessions(user_id: str = Depends(get_current_user_id)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_normalize_study_session_row(row) for row in (response.data or [])]


@router.get("/{session_id}", response_model=StudySessionResponse)
def get_study_session(session_id: str, user_id: str = Depends(get_current_user_id)):
    return _normalize_study_session_row(_get_study_session_or_404(user_id, session_id))


@router.put("/{session_id}", response_model=StudySessionResponse)
@work_route
def update_study_session(
    session_id: str,
    payload: StudySessionUpdateRequest,
    user_id: str = Depends(get_current_user_id),
):
    updates = payload.model_dump(exclude_unset=True)
    expected_version = updates.pop("expected_version", None)
    updates = strip_client_publish_fields(updates)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")

    row = cas_update(
        get_supabase(),
        table=TABLE_NAME,
        user_id=user_id,
        item_id=session_id,
        expected_version=expected_version,
        prepare=lambda row: dict(updates),
        already_applied=lambda row: fields_match(row, updates, EDIT_FIELDS),
        normalize=_normalize_study_session_row,
        missing_detail="Study session not found",
    )
    return _normalize_study_session_row(row)


@router.delete("/{session_id}", response_model=StudySessionDeleteResponse)
def delete_study_session(session_id: str, user_id: str = Depends(get_current_user_id)):
    _get_study_session_or_404(user_id, session_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", session_id).eq("user_id", user_id).execute()
    return {"message": "Study session deleted successfully"}
