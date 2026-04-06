from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from auth import get_current_user
from supabase_client import get_supabase

router = APIRouter(prefix="/study-sessions", tags=["study_sessions"])
TABLE_NAME = "study_sessions"


class StudySessionCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    subject: Optional[str] = Field(default=None, max_length=200)
    notes: Optional[str] = None
    duration_seconds: int = Field(default=0, ge=0)


class StudySessionUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    subject: Optional[str] = Field(default=None, max_length=200)
    notes: Optional[str] = None
    duration_seconds: Optional[int] = Field(default=None, ge=0)


class StudySessionResponse(BaseModel):
    id: str
    user_id: str
    name: str
    subject: Optional[str] = None
    notes: Optional[str] = None
    duration_seconds: int
    created_at: str


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
def create_study_session(payload: StudySessionCreateRequest, user_id: str = Depends(get_current_user)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .insert(
            {
                "user_id": user_id,
                "name": payload.name,
                "subject": payload.subject,
                "notes": payload.notes,
                "duration_seconds": payload.duration_seconds,
            }
        )
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create study session",
        )
    return _normalize_study_session_row(rows[0])


@router.get("", response_model=list[StudySessionResponse])
def list_study_sessions(user_id: str = Depends(get_current_user)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_normalize_study_session_row(row) for row in (response.data or [])]


@router.put("/{session_id}", response_model=StudySessionResponse)
def update_study_session(
    session_id: str,
    payload: StudySessionUpdateRequest,
    user_id: str = Depends(get_current_user),
):
    _get_study_session_or_404(user_id, session_id)

    updates = payload.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")

    get_supabase().table(TABLE_NAME).update(updates).eq("id", session_id).eq("user_id", user_id).execute()
    updated_row = _get_study_session_or_404(user_id, session_id)
    return _normalize_study_session_row(updated_row)


@router.delete("/{session_id}", response_model=StudySessionDeleteResponse)
def delete_study_session(session_id: str, user_id: str = Depends(get_current_user)):
    _get_study_session_or_404(user_id, session_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", session_id).eq("user_id", user_id).execute()
    return {"message": "Study session deleted successfully"}
