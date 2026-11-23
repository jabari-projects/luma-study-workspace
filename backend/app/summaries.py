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
from .publishing import apply_update_publish_rules, build_create_publish_fields
from .subjects import SUBJECT_FIELDS, check_sent_subject, checked_create_pair, subject_changes
from .supabase_client import get_supabase

router = APIRouter(prefix="/summaries", tags=["summaries"])
TABLE_NAME = "summaries"
STUDY_TYPE = "summary"
# What a student edits. A retried save whose first copy landed already matches on these.
EDIT_FIELDS = ("title", "content", "tags", "is_public", *SUBJECT_FIELDS)


class SummaryCreateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    content: str = Field(..., min_length=1)
    tags: list[str] = Field(default_factory=list)
    # A subject and subtopic from app/data/subjects.json (both optional; old websites never send them).
    subject_slug: Optional[str] = Field(default=None, max_length=40)
    subtopic_slug: Optional[str] = Field(default=None, max_length=40)
    # Accepted so the current frontend keeps working, but ignored: new items
    # are always private and the server sets the publish metadata.
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None
    updated_at: Optional[str] = None


class SummaryUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    content: Optional[str] = Field(default=None, min_length=1)
    tags: Optional[list[str]] = None
    # A subject and subtopic from app/data/subjects.json (both optional; old websites never send them).
    subject_slug: Optional[str] = Field(default=None, max_length=40)
    subtopic_slug: Optional[str] = Field(default=None, max_length=40)
    is_public: Optional[bool] = None
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None
    updated_at: Optional[str] = None
    # The version the editor loaded. Missing only from browsers still on the old frontend.
    expected_version: Optional[int] = Field(default=None, ge=1)


class SummaryResponse(BaseModel):
    id: str
    user_id: str
    title: str = ""
    content: str
    tags: list[str] = Field(default_factory=list)
    subject_slug: Optional[str] = None
    subtopic_slug: Optional[str] = None
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: str = "summary"
    created_at: str
    updated_at: Optional[str] = None
    version: int = 1


class SummaryDeleteResponse(BaseModel):
    message: str


def _normalize_summary_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "title": row.get("title") or "",
        "content": row.get("content") or "",
        "tags": row.get("tags") or [],
        "subject_slug": row.get("subject_slug"),
        "subtopic_slug": row.get("subtopic_slug"),
        "is_public": bool(row.get("is_public", False)),
        "published_at": row.get("published_at"),
        "published_by": row.get("published_by"),
        "study_type": row.get("study_type") or "summary",
        "created_at": row["created_at"],
        "updated_at": row.get("updated_at"),
        "version": row_version(row),
    }


def _get_summary_or_404(user_id: str, summary_id: str) -> dict:
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("id", summary_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Summary not found")
    return rows[0]


@router.post("", response_model=SummaryResponse, status_code=status.HTTP_201_CREATED)
@work_route
def create_summary(
    payload: SummaryCreateRequest,
    response: Response,
    user_id: str = Depends(get_current_user_id),
    idempotency_key: Optional[str] = Header(default=None, alias=IDEMPOTENCY_HEADER),
):
    row = idempotent_insert(
        get_supabase(),
        TABLE_NAME,
        user_id,
        {
            "title": payload.title,
            "content": payload.content,
            "tags": payload.tags,
            **checked_create_pair(payload.subject_slug, payload.subtopic_slug),
            **build_create_publish_fields(STUDY_TYPE),
        },
        parse_idempotency_key(idempotency_key),
        response,
        "Failed to create summary",
    )
    return _normalize_summary_row(row)


@router.get("", response_model=list[SummaryResponse])
def list_summaries(user_id: str = Depends(get_current_user_id)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_normalize_summary_row(row) for row in (response.data or [])]


@router.get("/{summary_id}", response_model=SummaryResponse)
def get_summary(summary_id: str, user_id: str = Depends(get_current_user_id)):
    return _normalize_summary_row(_get_summary_or_404(user_id, summary_id))


@router.put("/{summary_id}", response_model=SummaryResponse)
@work_route
def update_summary(summary_id: str, payload: SummaryUpdateRequest, user_id: str = Depends(get_current_user_id)):
    updates = payload.model_dump(exclude_unset=True)
    expected_version = updates.pop("expected_version", None)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")

    check_sent_subject(updates)

    def prepare(row: dict) -> dict:
        changes = subject_changes(dict(updates), row.get("subject_slug"))
        return apply_update_publish_rules(row, changes, user_id=user_id, study_type=STUDY_TYPE)

    row = cas_update(
        get_supabase(),
        table=TABLE_NAME,
        user_id=user_id,
        item_id=summary_id,
        expected_version=expected_version,
        prepare=prepare,
        already_applied=lambda row: fields_match(row, updates, EDIT_FIELDS),
        normalize=_normalize_summary_row,
        missing_detail="Summary not found",
    )
    return _normalize_summary_row(row)


@router.delete("/{summary_id}", response_model=SummaryDeleteResponse)
def delete_summary(summary_id: str, user_id: str = Depends(get_current_user_id)):
    _get_summary_or_404(user_id, summary_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", summary_id).eq("user_id", user_id).execute()
    return {"message": "Summary deleted successfully"}
