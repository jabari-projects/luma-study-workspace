from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from auth import get_current_user
from supabase_client import get_supabase

router = APIRouter(prefix="/flashcards", tags=["flashcards"])
TABLE_NAME = "flashcards"


class FlashcardCreateRequest(BaseModel):
    front: str = Field(..., min_length=1)
    back: str = Field(..., min_length=1)
    tags: list[str] = Field(default_factory=list)


class FlashcardUpdateRequest(BaseModel):
    front: Optional[str] = Field(default=None, min_length=1)
    back: Optional[str] = Field(default=None, min_length=1)
    tags: Optional[list[str]] = None


class FlashcardResponse(BaseModel):
    id: str
    user_id: str
    front: str
    back: str
    tags: list[str] = Field(default_factory=list)
    created_at: str


class FlashcardDeleteResponse(BaseModel):
    message: str


def _normalize_flashcard_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "front": row.get("front") or "",
        "back": row.get("back") or "",
        "tags": row.get("tags") or [],
        "created_at": row["created_at"],
    }


def _get_flashcard_or_404(user_id: str, flashcard_id: str) -> dict:
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("id", flashcard_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Flashcard not found")
    return rows[0]


@router.post("", response_model=FlashcardResponse, status_code=status.HTTP_201_CREATED)
def create_flashcard(payload: FlashcardCreateRequest, user_id: str = Depends(get_current_user)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .insert(
            {
                "user_id": user_id,
                "front": payload.front,
                "back": payload.back,
                "tags": payload.tags,
            }
        )
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create flashcard",
        )
    return _normalize_flashcard_row(rows[0])


@router.get("", response_model=list[FlashcardResponse])
def list_flashcards(user_id: str = Depends(get_current_user)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_normalize_flashcard_row(row) for row in (response.data or [])]


@router.put("/{flashcard_id}", response_model=FlashcardResponse)
def update_flashcard(
    flashcard_id: str,
    payload: FlashcardUpdateRequest,
    user_id: str = Depends(get_current_user),
):
    _get_flashcard_or_404(user_id, flashcard_id)

    updates = payload.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")

    get_supabase().table(TABLE_NAME).update(updates).eq("id", flashcard_id).eq("user_id", user_id).execute()
    updated_row = _get_flashcard_or_404(user_id, flashcard_id)
    return _normalize_flashcard_row(updated_row)


@router.delete("/{flashcard_id}", response_model=FlashcardDeleteResponse)
def delete_flashcard(flashcard_id: str, user_id: str = Depends(get_current_user)):
    _get_flashcard_or_404(user_id, flashcard_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", flashcard_id).eq("user_id", user_id).execute()
    return {"message": "Flashcard deleted successfully"}
