from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .auth import get_current_user_id
from .supabase_client import get_supabase

router = APIRouter(prefix="/summaries", tags=["summaries"])
TABLE_NAME = "summaries"


class SummaryCreateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    content: str = Field(..., min_length=1)
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None


class SummaryUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    content: Optional[str] = Field(default=None, min_length=1)
    is_public: Optional[bool] = None
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None


class SummaryResponse(BaseModel):
    id: str
    user_id: str
    title: str = ""
    content: str
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: str = "summary"
    created_at: str


class SummaryDeleteResponse(BaseModel):
    message: str


def _normalize_summary_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "title": row.get("title") or "",
        "content": row.get("content") or "",
        "is_public": bool(row.get("is_public", False)),
        "published_at": row.get("published_at"),
        "published_by": row.get("published_by"),
        "study_type": row.get("study_type") or "summary",
        "created_at": row["created_at"],
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
def create_summary(payload: SummaryCreateRequest, user_id: str = Depends(get_current_user_id)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .insert(
            {
                "user_id": user_id,
                "title": payload.title,
                "content": payload.content,
                "is_public": payload.is_public,
                "published_at": payload.published_at,
                "published_by": payload.published_by,
                "study_type": payload.study_type or "summary",
            }
        )
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create summary",
        )
    return _normalize_summary_row(rows[0])


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


@router.put("/{summary_id}", response_model=SummaryResponse)
def update_summary(summary_id: str, payload: SummaryUpdateRequest, user_id: str = Depends(get_current_user_id)):
    _get_summary_or_404(user_id, summary_id)

    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")

    get_supabase().table(TABLE_NAME).update(updates).eq("id", summary_id).eq("user_id", user_id).execute()
    updated_row = _get_summary_or_404(user_id, summary_id)
    return _normalize_summary_row(updated_row)


@router.delete("/{summary_id}", response_model=SummaryDeleteResponse)
def delete_summary(summary_id: str, user_id: str = Depends(get_current_user_id)):
    _get_summary_or_404(user_id, summary_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", summary_id).eq("user_id", user_id).execute()
    return {"message": "Summary deleted successfully"}
