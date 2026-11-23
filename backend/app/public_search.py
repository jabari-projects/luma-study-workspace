"""Search the study sets students chose to share.

Privacy rules (owner decisions, 2026-11-16):
- Only signed-in students can search. There is no anonymous access.
- A shared item shows its username only: never a user id, display name or photo.
- No popularity counts, and nothing is sorted by how much someone shared. The Discover
  filter counts are per subject or type (how many shared items), never per person.

All three routes read through one SQL function, public.public_study_search
(2026_11_24_subjects.sql). It returns owner ids; this module swaps each one for the owner's
current username and never sends the id.
"""

import re
from dataclasses import dataclass
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .auth import get_current_user_id
from .subjects import STOP_WORDS, fold, subject_exists, subjects_matching, subtopic_exists, word_needle
from .supabase_client import get_supabase

router = APIRouter(prefix="/public", tags=["public"])
StudyType = Literal["note", "flashcards", "summary"]
STUDY_TYPES = ("note", "flashcards", "summary")

# One page of search results, the furthest a student can page, and the longest search.
PAGE_SIZE = 30
MAX_OFFSET = 400
MAX_QUERY_LENGTH = 80
# The most words one search looks at (the rest are ignored).
MAX_SEARCH_WORDS = 8
# A word with any of these is matched as typed ("1+1", "50%", "c++"); "." and "'" fold away.
_LITERAL_MARKS = re.compile(r"[^\w.'’-]|_")
# People search needs this many letters, so nobody can list every student who shared.
MIN_USER_QUERY_LENGTH = 3
# Usernames only ever use these characters (see the signup and rename rules in main.py).
_USERNAME_CHARS = re.compile(r"^[A-Za-z0-9_]+$")
# How many usernames one people search looks at, and how many people it returns.
PEOPLE_LOOKUP_LIMIT = 100
PEOPLE_RESULT_LIMIT = 40
# Newest shared items listed under each person, and how many rows one people search reads.
ITEMS_PER_PERSON = 24
PEOPLE_ITEMS_LIMIT = 500


class PublicStudyItem(BaseModel):
    # forbid: a field added here by mistake fails loudly instead of leaking.
    model_config = ConfigDict(extra="forbid")

    id: str
    study_type: StudyType
    title: str
    preview: str
    tags: list[str] = Field(default_factory=list)
    # From app/data/subjects.json, or null ("No subject"). Not personal data.
    subject_slug: Optional[str] = None
    subtopic_slug: Optional[str] = None
    username: str
    published_at: Optional[str] = None
    created_at: str


class PublicUser(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str
    items: list[PublicStudyItem] = Field(default_factory=list)


class SlugCount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # null means "No subject" (or "No subtopic").
    slug: Optional[str] = None
    count: int


class TypeCount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: StudyType
    count: int


class SearchFacets(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subjects: list[SlugCount] = Field(default_factory=list)
    subtopics: list[SlugCount] = Field(default_factory=list)
    types: list[TypeCount] = Field(default_factory=list)


class PublicSearchAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PublicStudyItem]
    total: int
    next_offset: Optional[int] = None
    facets: SearchFacets


@dataclass
class _Found:
    """A shared item plus its owner's id. The id stays on the server."""

    user_id: str
    item: PublicStudyItem


def _as_text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _as_tags(value: object) -> list[str]:
    if not isinstance(value, list):
        return []

    return [str(tag) for tag in value if str(tag).strip()]


def _as_slug(value: object) -> Optional[str]:
    return value if isinstance(value, str) and value else None


# Markdown marks that should not show up in a plain preview.
_MD_RULE = re.compile(r"^[ \t]*(?:[-*_][ \t]*){3,}$", re.MULTILINE)
_MD_LINE_MARKS = re.compile(r"^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)", re.MULTILINE)
_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_EMPHASIS = re.compile(r"\*+|~~|`+|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])")
_CARD_SEPARATOR = re.compile(r"[ \t]*::[ \t]*")


def _plain_text(value: str) -> str:
    """Note text without Markdown marks, so a preview reads like normal words."""
    text = _MD_RULE.sub(" ", value)
    text = _MD_LINE_MARKS.sub("", text)
    text = _MD_IMAGE.sub(r"\1", text)
    text = _MD_LINK.sub(r"\1", text)
    text = _CARD_SEPARATOR.sub(" - ", text)
    return _MD_EMPHASIS.sub("", text)


def _clip(value: str, limit: int = 220) -> str:
    normalized = " ".join(_plain_text(value).split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 3].rstrip()}..."


def _escape_like(text: str) -> str:
    """Make %, _ and backslash match themselves in an ilike pattern."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _profile_lookup(user_ids: list[str]) -> dict[str, dict]:
    unique_user_ids = list(dict.fromkeys(user_ids))
    if not unique_user_ids:
        return {}

    response = (
        get_supabase()
        .table("profiles")
        .select("user_id, username")
        .in_("user_id", unique_user_ids)
        .execute()
    )
    return {row["user_id"]: row for row in (response.data or []) if row.get("user_id")}


def _username_for(profile: Optional[dict]) -> str:
    # Only the owner's current username. A stored published_by may be an old name
    # (renamed account) or spoofed (rows shared before the server set it), so it
    # never shows. Never build a name from the user id either: that leaks part of it.
    if profile and isinstance(profile.get("username"), str) and profile["username"].strip():
        return profile["username"]
    return "student"


def search_words(raw: str) -> list[str]:
    """The words a search looks for, in any order: each loses a leading # (old tag habit).

    Small words ("the", "of") are dropped when other words are there. At most MAX_SEARCH_WORDS.
    """
    words = [word for word in (part.lstrip("#").lower() for part in raw.split()) if word]
    kept = [word for word in words if fold(word) not in STOP_WORDS] or words
    return list(dict.fromkeys(kept))[:MAX_SEARCH_WORDS]


def search_terms(raw: str) -> list[dict]:
    """One term per search word for public_study_search. Every term must match an item.

    A term matches when the item's words hold it (see word_needle: whole word for 1-2 letters,
    the start of a word for longer ones, with "U.S." folded to "us"), or, for words of 4+
    letters, anywhere in the text as typed, or when the item's subject or subtopic is named by
    it. A word with marks like "1+1" or "50%" only matches exactly as typed.
    """
    terms = []
    for word in search_words(raw):
        folded = fold(word)
        literal = not folded or bool(_LITERAL_MARKS.search(word))
        terms.append(
            {
                "like": f"%{_escape_like(word)}%" if literal or len(folded) >= 4 else None,
                "word": None if literal else f"%{_escape_like(word_needle(folded))}%",
                "pairs": [] if literal else [{"subject": slug, "subtopic": sub} for slug, sub in subjects_matching(folded)],
            }
        )
    return terms


def _run_search(
    *,
    text: str = "",
    subject: Optional[str] = None,
    subtopic: Optional[str] = None,
    study_type: Optional[str] = None,
    user_ids: Optional[list[str]] = None,
    limit: Optional[int] = None,
    offset: int = 0,
) -> dict:
    """One call to public.public_study_search. Its rows carry owner ids: never send them on."""
    params = {
        "p_terms": search_terms(text),
        "p_subject": subject,
        "p_subtopic": subtopic,
        "p_type": study_type,
        "p_user_ids": user_ids,
        "p_limit": PAGE_SIZE if limit is None else limit,
        "p_offset": offset,
    }
    data = get_supabase().rpc("public_study_search", params).execute().data
    return data if isinstance(data, dict) else {}


def _found_items(rows: list) -> list[_Found]:
    """Shared rows as items with the owner's current username."""
    rows = [row for row in rows if isinstance(row, dict)]
    profiles = _profile_lookup([_as_text(row.get("user_id")) for row in rows if _as_text(row.get("user_id"))])
    found: list[_Found] = []
    for row in rows:
        title = _as_text(row.get("title"))
        study_type = row.get("study_type")
        if not title.strip() or study_type not in STUDY_TYPES:
            continue
        user_id = _as_text(row.get("user_id"))
        found.append(
            _Found(
                user_id=user_id,
                item=PublicStudyItem(
                    id=str(row["id"]),
                    study_type=study_type,
                    title=title,
                    preview=_clip(_as_text(row.get("body"))),
                    tags=_as_tags(row.get("tags")),
                    subject_slug=_as_slug(row.get("subject_slug")),
                    subtopic_slug=_as_slug(row.get("subtopic_slug")),
                    username=_username_for(profiles.get(user_id)),
                    published_at=str(row.get("published_at") or row.get("created_at") or ""),
                    created_at=str(row.get("created_at") or ""),
                ),
            )
        )
    return found


def _count(value: object) -> int:
    try:
        return max(int(value or 0), 0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def _facets(answer: dict) -> SearchFacets:
    def entries(key: str) -> list[dict]:
        return [entry for entry in answer.get(key) or [] if isinstance(entry, dict) and _count(entry.get("count")) > 0]

    return SearchFacets(
        subjects=[SlugCount(slug=_as_slug(e.get("slug")), count=_count(e.get("count"))) for e in entries("subjects")],
        subtopics=[SlugCount(slug=_as_slug(e.get("slug")), count=_count(e.get("count"))) for e in entries("subtopics")],
        types=[TypeCount(type=e["type"], count=_count(e.get("count"))) for e in entries("types") if e.get("type") in STUDY_TYPES],
    )


def _not_on_list() -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": "That subject isn't on the list.", "error_code": "unknown_subject"},
    )


@router.get("/search", response_model=PublicSearchAnswer)
def search_public(
    q: str = Query(default="", max_length=MAX_QUERY_LENGTH),
    subject: Optional[str] = Query(default=None, max_length=40),
    subtopic: Optional[str] = Query(default=None, max_length=40),
    type: Optional[StudyType] = Query(default=None),
    offset: int = Query(default=0, ge=0, le=MAX_OFFSET),
    _user_id: str = Depends(get_current_user_id),
):
    """Everything students shared, narrowed by words, a subject, a subtopic and a type, with counts.

    total and items follow every filter. facets.subjects ignores the chosen subject and subtopic
    (so the other subjects stay in view), facets.subtopics (only with a subject) ignores the
    chosen subtopic, and facets.types ignores the chosen type.
    """
    if subject is not None and not subject_exists(subject):
        return _not_on_list()
    if subtopic is not None and not subtopic_exists(subject, subtopic):
        return _not_on_list()
    answer = _run_search(text=q, subject=subject, subtopic=subtopic, study_type=type, offset=offset)
    total = _count(answer.get("total"))
    following = offset + PAGE_SIZE
    return PublicSearchAnswer(
        items=[found.item for found in _found_items(answer.get("rows") or [])],
        total=total,
        next_offset=following if following < total and following <= MAX_OFFSET else None,
        facets=_facets(answer),
    )


# OVERLAP(remove after the website with /public/search is live): websites still open from
# before this release ask /public/topics. It answers with the first page of the same search.
@router.get("/topics", response_model=list[PublicStudyItem])
def search_public_topics(
    query: str = Query(default="", max_length=MAX_QUERY_LENGTH),
    _user_id: str = Depends(get_current_user_id),
):
    return [found.item for found in _found_items(_run_search(text=query).get("rows") or [])]


def _profiles_named_like(wanted: str) -> list[dict]:
    """Profiles whose username contains `wanted` (any case). The exact name is always looked up too."""
    escaped = _escape_like(wanted)
    found: dict[str, dict] = {}
    for pattern, limit in ((escaped, 5), (f"%{escaped}%", PEOPLE_LOOKUP_LIMIT)):
        response = (
            get_supabase()
            .table("profiles")
            .select("user_id, username")
            .ilike("username", pattern)
            .limit(limit)
            .execute()
        )
        for row in response.data or []:
            username = row.get("username")
            if row.get("user_id") and isinstance(username, str) and wanted in username.lower():
                found.setdefault(row["user_id"], row)
    return list(found.values())


@router.get("/users", response_model=list[PublicUser])
def search_public_users(
    query: str = Query(default="", max_length=MAX_QUERY_LENGTH),
    _user_id: str = Depends(get_current_user_id),
):
    wanted = query.strip().lstrip("@").lower()
    # Usernames are letters, numbers and _ only, so anything else can't match anybody.
    if len(wanted) < MIN_USER_QUERY_LENGTH or not _USERNAME_CHARS.match(wanted):
        return []

    # Look the name up first, then fetch only those students' shared items. Someone who
    # shared long ago is still found, however many newer items other students shared.
    profiles = {row["user_id"]: row for row in _profiles_named_like(wanted)}
    if not profiles:
        return []

    rows = _run_search(user_ids=list(profiles), limit=PEOPLE_ITEMS_LIMIT).get("rows") or []
    by_user: dict[str, list[PublicStudyItem]] = {}
    for found in _found_items(rows):
        by_user.setdefault(found.user_id, []).append(found.item)

    # Only students who shared something are listed, each with their newest items.
    users = [
        PublicUser(username=profiles[user_id]["username"], items=items[:ITEMS_PER_PERSON])
        for user_id, items in by_user.items()
        if user_id in profiles
    ]

    # Closest names first (exact, then starts-with), then A to Z. Never by how much they shared.
    def rank(user: PublicUser) -> tuple[int, str]:
        name = user.username.lower()
        return (0 if name == wanted else 1 if name.startswith(wanted) else 2, name)

    return sorted(users, key=rank)[:PEOPLE_RESULT_LIMIT]
