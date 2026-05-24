from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .auth import get_current_user_id
from .supabase_client import get_supabase

router = APIRouter(prefix="/notes", tags=["notes"])
TABLE_NAME = "notes"


class NoteCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(..., min_length=1)
    tags: list[str] = Field(default_factory=list)
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None


class NoteUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    content: Optional[str] = Field(default=None, min_length=1)
    tags: Optional[list[str]] = None
    is_public: Optional[bool] = None
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None


class NoteResponse(BaseModel):
    id: str
    user_id: str
    title: str
    content: str
    tags: list[str] = Field(default_factory=list)
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: str = "note"
    created_at: str


class NoteDeleteResponse(BaseModel):
    message: str


def _normalize_note_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "title": row.get("title") or "",
        "content": row.get("content") or "",
        "tags": row.get("tags") or [],
        "is_public": bool(row.get("is_public", False)),
        "published_at": row.get("published_at"),
        "published_by": row.get("published_by"),
        "study_type": row.get("study_type") or "note",
        "created_at": row["created_at"],
    }


def _get_note_or_404(user_id: str, note_id: str) -> dict:
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("id", note_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return rows[0]


@router.post("", response_model=NoteResponse, status_code=status.HTTP_201_CREATED)
def create_note(payload: NoteCreateRequest, user_id: str = Depends(get_current_user_id)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .insert(
            {
                "user_id": user_id,
                "title": payload.title,
                "content": payload.content,
                "tags": payload.tags,
                "is_public": payload.is_public,
                "published_at": payload.published_at,
                "published_by": payload.published_by,
                "study_type": payload.study_type or "note",
            }
        )
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create note")
    return _normalize_note_row(rows[0])


@router.get("", response_model=list[NoteResponse])
def list_notes(user_id: str = Depends(get_current_user_id)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_normalize_note_row(row) for row in (response.data or [])]


@router.put("/{note_id}", response_model=NoteResponse)
def update_note(note_id: str, payload: NoteUpdateRequest, user_id: str = Depends(get_current_user_id)):
    _get_note_or_404(user_id, note_id)

    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")

    get_supabase().table(TABLE_NAME).update(updates).eq("id", note_id).eq("user_id", user_id).execute()
    updated_row = _get_note_or_404(user_id, note_id)
    return _normalize_note_row(updated_row)


@router.delete("/{note_id}", response_model=NoteDeleteResponse)
def delete_note(note_id: str, user_id: str = Depends(get_current_user_id)):
    _get_note_or_404(user_id, note_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", note_id).eq("user_id", user_id).execute()
    return {"message": "Note deleted successfully"}
