from datetime import datetime
from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator

from .auth import get_current_user_id
from .publishing import apply_update_publish_rules, build_create_publish_fields
from .supabase_client import get_supabase

router = APIRouter(prefix="/flashcards", tags=["flashcards"])
TABLE_NAME = "flashcards"
STUDY_TYPE = "flashcards"


MAX_CARDS_PER_DECK = 500


class FlashcardCard(BaseModel):
    """One card inside a deck. `review` holds spaced-repetition state owned by the client scheduler."""

    id: str = Field(default_factory=lambda: uuid4().hex, min_length=1, max_length=64)
    front: str = Field(..., min_length=1, max_length=4000)
    back: str = Field(..., min_length=1, max_length=4000)
    review: Optional[dict[str, Any]] = None


def _clean_cards(cards: Optional[list[FlashcardCard]]) -> Optional[list[FlashcardCard]]:
    if cards is None:
        return None
    cleaned = [card for card in cards if card.front.strip() and card.back.strip()]
    if len(cleaned) > MAX_CARDS_PER_DECK:
        raise ValueError(f"A deck can have up to {MAX_CARDS_PER_DECK} cards.")
    return cleaned


class FlashcardCreateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    front: Optional[str] = Field(default=None, min_length=1)
    back: Optional[str] = Field(default=None, min_length=1)
    cards: Optional[list[FlashcardCard]] = None
    tags: list[str] = Field(default_factory=list)
    # Accepted so the current frontend keeps working, but ignored: new items
    # are always private and the server sets the publish metadata.
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None
    updated_at: Optional[str] = None

    @model_validator(mode="after")
    def _require_cards(self) -> "FlashcardCreateRequest":
        self.cards = _clean_cards(self.cards)
        if not self.cards:
            if not (self.front and self.front.strip() and self.back and self.back.strip()):
                raise ValueError("Add at least one card with a question and an answer.")
            self.cards = [FlashcardCard(front=self.front, back=self.back)]
        return self


class FlashcardUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    front: Optional[str] = Field(default=None, min_length=1)
    back: Optional[str] = Field(default=None, min_length=1)
    cards: Optional[list[FlashcardCard]] = None
    tags: Optional[list[str]] = None
    is_public: Optional[bool] = None
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: Optional[str] = None
    updated_at: Optional[str] = None

    @model_validator(mode="after")
    def _check_cards(self) -> "FlashcardUpdateRequest":
        if "cards" in self.model_fields_set:
            self.cards = _clean_cards(self.cards)
            if not self.cards:
                raise ValueError("A deck needs at least one card.")
        return self


class FlashcardResponse(BaseModel):
    id: str
    user_id: str
    title: str = ""
    front: str
    back: str
    cards: list[FlashcardCard] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: str = "flashcards"
    created_at: str
    updated_at: Optional[str] = None


class FlashcardDeleteResponse(BaseModel):
    message: str


def _row_cards(row: dict) -> list[dict]:
    cards = row.get("cards")
    if isinstance(cards, list) and cards:
        return [card for card in cards if isinstance(card, dict) and card.get("front") and card.get("back")]
    if row.get("front") and row.get("back"):
        # Older single-card rows become a one-card deck.
        return [{"id": f"{row['id']}-0", "front": row["front"], "back": row["back"], "review": None}]
    return []


def _cards_payload(cards: list[FlashcardCard]) -> dict:
    """Store the deck plus mirror the first card into the legacy front/back columns."""
    dumped = [card.model_dump() for card in cards]
    return {"cards": dumped, "front": dumped[0]["front"], "back": dumped[0]["back"]}


def _normalize_flashcard_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "title": row.get("title") or "",
        "front": row.get("front") or "",
        "back": row.get("back") or "",
        "cards": _row_cards(row),
        "tags": row.get("tags") or [],
        "is_public": bool(row.get("is_public", False)),
        "published_at": row.get("published_at"),
        "published_by": row.get("published_by"),
        "study_type": row.get("study_type") or "flashcards",
        "created_at": row["created_at"],
        "updated_at": row.get("updated_at"),
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
def create_flashcard(payload: FlashcardCreateRequest, user_id: str = Depends(get_current_user_id)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .insert(
            {
                "user_id": user_id,
                "title": payload.title,
                **_cards_payload(payload.cards or []),
                "tags": payload.tags,
                **build_create_publish_fields(STUDY_TYPE),
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
def list_flashcards(user_id: str = Depends(get_current_user_id)):
    response = (
        get_supabase()
        .table(TABLE_NAME)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_normalize_flashcard_row(row) for row in (response.data or [])]


@router.get("/{flashcard_id}", response_model=FlashcardResponse)
def get_flashcard(flashcard_id: str, user_id: str = Depends(get_current_user_id)):
    return _normalize_flashcard_row(_get_flashcard_or_404(user_id, flashcard_id))


@router.put("/{flashcard_id}", response_model=FlashcardResponse)
def update_flashcard(
    flashcard_id: str,
    payload: FlashcardUpdateRequest,
    user_id: str = Depends(get_current_user_id),
):
    existing_row = _get_flashcard_or_404(user_id, flashcard_id)

    updates = payload.model_dump(exclude_unset=True)
    if "cards" in updates:
        updates.update(_cards_payload(payload.cards or []))
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")
    updates = apply_update_publish_rules(existing_row, updates, user_id=user_id, study_type=STUDY_TYPE)

    updates["updated_at"] = datetime.utcnow().isoformat()
    get_supabase().table(TABLE_NAME).update(updates).eq("id", flashcard_id).eq("user_id", user_id).execute()
    updated_row = _get_flashcard_or_404(user_id, flashcard_id)
    return _normalize_flashcard_row(updated_row)


@router.delete("/{flashcard_id}", response_model=FlashcardDeleteResponse)
def delete_flashcard(flashcard_id: str, user_id: str = Depends(get_current_user_id)):
    _get_flashcard_or_404(user_id, flashcard_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", flashcard_id).eq("user_id", user_id).execute()
    return {"message": "Flashcard deleted successfully"}
