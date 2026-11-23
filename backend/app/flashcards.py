from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from .auth import get_current_user_id
from .edit_versions import (
    IDEMPOTENCY_HEADER,
    MAX_CAS_ROUNDS,
    PROGRESS_BUSY_DETAIL,
    cas_update,
    fields_match,
    gone,
    idempotent_insert,
    load_row,
    parse_idempotency_key,
    row_version,
    work_route,
)
from .publishing import apply_update_publish_rules, build_create_publish_fields
from .subjects import SUBJECT_FIELDS, check_sent_subject, checked_create_pair, subject_changes
from .supabase_client import get_supabase

router = APIRouter(prefix="/flashcards", tags=["flashcards"])
TABLE_NAME = "flashcards"
STUDY_TYPE = "flashcards"
# What a student edits besides the cards. A retried save whose first copy landed already
# matches on these (and on the cards' words).
EDIT_FIELDS = ("title", "tags", "is_public", *SUBJECT_FIELDS)


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
    subject_slug: Optional[str] = None
    subtopic_slug: Optional[str] = None
    is_public: bool = False
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    study_type: str = "flashcards"
    created_at: str
    updated_at: Optional[str] = None
    version: int = 1


class FlashcardDeleteResponse(BaseModel):
    message: str


class FlashcardProgressRequest(BaseModel):
    """Review progress for some cards of one deck: card id -> review state (or null to start over)."""

    reviews: dict[str, Optional[dict[str, Any]]]

    @field_validator("reviews")
    @classmethod
    def _check_reviews(cls, reviews: dict[str, Optional[dict[str, Any]]]) -> dict[str, Optional[dict[str, Any]]]:
        if not reviews:
            raise ValueError("Send at least one card's progress.")
        if len(reviews) > MAX_CARDS_PER_DECK:
            raise ValueError(f"A deck can have up to {MAX_CARDS_PER_DECK} cards.")
        if any(not key or len(key) > 64 for key in reviews):
            raise ValueError("A card id is missing or too long.")
        return reviews


class FlashcardProgressResponse(BaseModel):
    version: int
    progress_rev: int


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
    return _cards_columns([card.model_dump() for card in cards])


def _cards_columns(cards: list[dict]) -> dict:
    return {"cards": cards, "front": cards[0]["front"], "back": cards[0]["back"]}


def _progress_rev(row: dict) -> int:
    value = row.get("progress_rev")
    return int(value) if value is not None else 0


def _card_words(cards: list[dict]) -> list[dict]:
    """A deck's cards without review progress, to tell whether a save is already stored."""
    return [{"id": card.get("id"), "front": card.get("front"), "back": card.get("back")} for card in cards]


def _with_stored_reviews(sent: list[dict], stored: list[dict]) -> list[dict]:
    """The editor's cards, each keeping the progress stored for its id. New ids start fresh."""
    reviews = {card.get("id"): card.get("review") for card in stored}
    return [{**card, "review": reviews.get(card["id"])} for card in sent]


def _normalize_flashcard_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "title": row.get("title") or "",
        "front": row.get("front") or "",
        "back": row.get("back") or "",
        "cards": _row_cards(row),
        "tags": row.get("tags") or [],
        "subject_slug": row.get("subject_slug"),
        "subtopic_slug": row.get("subtopic_slug"),
        "is_public": bool(row.get("is_public", False)),
        "published_at": row.get("published_at"),
        "published_by": row.get("published_by"),
        "study_type": row.get("study_type") or "flashcards",
        "created_at": row["created_at"],
        "updated_at": row.get("updated_at"),
        "version": row_version(row),
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
@work_route
def create_flashcard(
    payload: FlashcardCreateRequest,
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
            **_cards_payload(payload.cards or []),
            "tags": payload.tags,
            **checked_create_pair(payload.subject_slug, payload.subtopic_slug),
            **build_create_publish_fields(STUDY_TYPE),
        },
        parse_idempotency_key(idempotency_key),
        response,
        "Failed to create flashcard",
    )
    return _normalize_flashcard_row(row)


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
@work_route
def update_flashcard(
    flashcard_id: str,
    payload: FlashcardUpdateRequest,
    user_id: str = Depends(get_current_user_id),
):
    updates = payload.model_dump(exclude_unset=True)
    expected_version = updates.pop("expected_version", None)
    sent_cards = [card.model_dump() for card in payload.cards or []] if "cards" in updates else None
    updates.pop("cards", None)
    if not updates and sent_cards is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields provided for update")

    check_sent_subject(updates)

    def prepare(row: dict) -> dict:
        changes = subject_changes(dict(updates), row.get("subject_slug"))
        if sent_cards is not None:
            if expected_version is None:
                # OVERLAP(remove after the frontend with expected_version is live): the old
                # study page saves progress by sending the whole deck, review included.
                cards = sent_cards
            else:
                # The editor never sends progress: keep what studying stored for each card.
                cards = _with_stored_reviews(sent_cards, _row_cards(row))
            changes.update(_cards_columns(cards))
        return apply_update_publish_rules(row, changes, user_id=user_id, study_type=STUDY_TYPE)

    def already_applied(row: dict) -> bool:
        if sent_cards is not None and _card_words(_row_cards(row)) != _card_words(sent_cards):
            return False
        sent_fields = [field for field in EDIT_FIELDS if field in updates]
        return (sent_cards is not None or bool(sent_fields)) and (
            not sent_fields or fields_match(row, updates, EDIT_FIELDS)
        )

    row = cas_update(
        get_supabase(),
        table=TABLE_NAME,
        user_id=user_id,
        item_id=flashcard_id,
        expected_version=expected_version,
        prepare=prepare,
        already_applied=already_applied,
        normalize=_normalize_flashcard_row,
        missing_detail="Flashcard not found",
        # Studying in another tab moves progress_rev. Then this save reads the deck again
        # and merges the newest progress in (at most MAX_CAS_ROUNDS times).
        extra_match=lambda row: {"progress_rev": _progress_rev(row)},
    )
    return _normalize_flashcard_row(row)


@router.patch("/{flashcard_id}/progress", response_model=FlashcardProgressResponse)
@work_route
def save_flashcard_progress(
    flashcard_id: str,
    payload: FlashcardProgressRequest,
    user_id: str = Depends(get_current_user_id),
):
    """Merge review progress into the deck's cards. It never changes card words or `version`,
    so studying never conflicts with an open deck editor. Unknown card ids are ignored.
    The write checks both progress_rev and version, so neither writer undoes the other."""
    for _ in range(MAX_CAS_ROUNDS):
        row = load_row(get_supabase(), TABLE_NAME, user_id, flashcard_id)
        if row is None:
            raise gone("Flashcard not found")
        rev = _progress_rev(row)
        cards = [
            {**card, "review": payload.reviews[card["id"]]} if card.get("id") in payload.reviews else card
            for card in _row_cards(row)
        ]
        changes: dict[str, Any] = {"progress_rev": rev + 1}
        if cards:
            changes.update(_cards_columns(cards))
        rows = (
            get_supabase()
            .table(TABLE_NAME)
            .update(changes)
            .eq("id", flashcard_id)
            .eq("user_id", user_id)
            .eq("progress_rev", rev)
            # The deck editor's save moves `version` but not progress_rev. Matching both means
            # an editor save that lands between this read and write makes us read again, so
            # the old card words are never written back over the new ones.
            .eq("version", row_version(row))
            .execute()
            .data
            or []
        )
        if rows:
            return {"version": row_version(rows[0]), "progress_rev": _progress_rev(rows[0])}
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content={"detail": PROGRESS_BUSY_DETAIL, "error_code": "progress_busy"},
    )


@router.delete("/{flashcard_id}", response_model=FlashcardDeleteResponse)
def delete_flashcard(flashcard_id: str, user_id: str = Depends(get_current_user_id)):
    _get_flashcard_or_404(user_id, flashcard_id)
    get_supabase().table(TABLE_NAME).delete().eq("id", flashcard_id).eq("user_id", user_id).execute()
    return {"message": "Flashcard deleted successfully"}
