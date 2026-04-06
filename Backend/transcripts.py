from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from auth import get_current_user
from supabase_client import get_supabase

router = APIRouter(prefix="/transcripts", tags=["transcripts"])
TABLE_NAME = "transcripts"


class TranscriptCreateRequest(BaseModel):
    content: str = Field(..., min_length=1)


class TranscriptUpdateRequest(BaseModel):
    content: Optional[str] = Field(default=None, min_length=1)


class TranscriptResponse(BaseModel):
    id: str
    user_id: str
    content: str
    created_at: str


class TranscriptDeleteResponse(BaseModel):
    message: str


def _normalize_transcript_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "content": row.get("content") or "",
        "created_at": row["created_at"],
    }


def _get_transcript_or_404(user_id: str, transcript_id: str) -> dict:
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("id", transcript_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcript not found")
    return rows[0]


@router.post("", response_model=TranscriptResponse, status_code=status.HTTP_201_CREATED)
def create_transcript(payload: TranscriptCreateRequest, user_id: str = Depends(get_current_user)):
    response = get_supabase().table(TABLE_NAME).insert({"user_id": user_id, "content": payload.content}).execute()
    rows = response.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create transcript",
        )
    return _normalize_transcript_row(rows[0])


@router.get("", response_model=list[TranscriptResponse])
def list_transcripts(user_id: str = Depends(get_current_user)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_normalize_transcript_row(row) for row in (response.data or [])]


@router.put("/{transcript_id}", response_model=TranscriptResponse)
def update_transcript(
    transcript_id: str,
    payload: TranscriptUpdateRequest,
    user_id: str = Depends(get_current_user),
):
    _get_transcript_or_404(user_id, transcript_id)

    updates = payload.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")

    get_supabase().table(TABLE_NAME).update(updates).eq("id", transcript_id).eq("user_id", user_id).execute()
    updated_row = _get_transcript_or_404(user_id, transcript_id)
    return _normalize_transcript_row(updated_row)


@router.delete("/{transcript_id}", response_model=TranscriptDeleteResponse)
def delete_transcript(transcript_id: str, user_id: str = Depends(get_current_user)):
    _get_transcript_or_404(user_id, transcript_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", transcript_id).eq("user_id", user_id).execute()
    return {"message": "Transcript deleted successfully"}
