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
    work_route,
)
from .publishing import apply_update_publish_rules, build_create_publish_fields, require_title_text
from .supabase_client import get_supabase

router = APIRouter(prefix="/notes", tags=["notes"])
TABLE_NAME = "notes"
STUDY_TYPE = "note"
# What a student edits. A retried save whose first copy landed already matches on these.
EDIT_FIELDS = ("title", "content", "tags", "is_public")


class NoteCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(..., min_length=1)
    tags: list[str] = Field(default_factory=list)
    # Accepted so the current frontend keeps working, but ignored: new items
    # are always private and the server sets the publish metadata.
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None
    updated_at: Optional[str] = None


class NoteUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    content: Optional[str] = Field(default=None, min_length=1)
    tags: Optional[list[str]] = None
    is_public: Optional[bool] = None
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None
    updated_at: Optional[str] = None
    # The version the editor loaded. Missing only from browsers still on the old frontend.
    expected_version: Optional[int] = Field(default=None, ge=1)


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
    updated_at: Optional[str] = None
    version: int = 1


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
        "updated_at": row.get("updated_at"),
        "version": row_version(row),
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
@work_route
def create_note(
    payload: NoteCreateRequest,
    response: Response,
    user_id: str = Depends(get_current_user_id),
    idempotency_key: Optional[str] = Header(default=None, alias=IDEMPOTENCY_HEADER),
):
    require_title_text(payload.title)
    row = idempotent_insert(
        get_supabase(),
        TABLE_NAME,
        user_id,
        {
            "title": payload.title,
            "content": payload.content,
            "tags": payload.tags,
            **build_create_publish_fields(STUDY_TYPE),
        },
        parse_idempotency_key(idempotency_key),
        response,
        "Failed to create note",
    )
    return _normalize_note_row(row)


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


@router.get("/{note_id}", response_model=NoteResponse)
def get_note(note_id: str, user_id: str = Depends(get_current_user_id)):
    return _normalize_note_row(_get_note_or_404(user_id, note_id))


@router.put("/{note_id}", response_model=NoteResponse)
@work_route
def update_note(note_id: str, payload: NoteUpdateRequest, user_id: str = Depends(get_current_user_id)):
    updates = payload.model_dump(exclude_unset=True)
    expected_version = updates.pop("expected_version", None)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")
    require_title_text(updates.get("title"))

    def prepare(row: dict) -> dict:
        return apply_update_publish_rules(row, dict(updates), user_id=user_id, study_type=STUDY_TYPE)

    row = cas_update(
        get_supabase(),
        table=TABLE_NAME,
        user_id=user_id,
        item_id=note_id,
        expected_version=expected_version,
        prepare=prepare,
        already_applied=lambda row: fields_match(row, updates, EDIT_FIELDS),
        normalize=_normalize_note_row,
        missing_detail="Note not found",
    )
    return _normalize_note_row(row)


@router.delete("/{note_id}", response_model=NoteDeleteResponse)
def delete_note(note_id: str, user_id: str = Depends(get_current_user_id)):
    _get_note_or_404(user_id, note_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", note_id).eq("user_id", user_id).execute()
    return {"message": "Note deleted successfully"}
