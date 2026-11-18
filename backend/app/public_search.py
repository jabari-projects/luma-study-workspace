"""Search the study sets students chose to share.

Privacy rules (owner decisions, 2026-11-16):
- Only signed-in students can search. There is no anonymous access.
- A shared item shows its username only: never a user id, display name or photo.
- No popularity counts, and nothing is sorted by how much someone shared.
"""

import re
from dataclasses import dataclass
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from .auth import get_current_user_id
from .supabase_client import get_supabase

router = APIRouter(prefix="/public", tags=["public"])
StudyType = Literal["note", "flashcards", "summary"]

# People search needs this many letters, so nobody can list every student who shared.
MIN_USER_QUERY_LENGTH = 3
# Usernames only ever use these characters (see the signup and rename rules in main.py).
_USERNAME_CHARS = re.compile(r"^[A-Za-z0-9_]+$")
# How many usernames one people search looks at, and how many people it returns.
PEOPLE_LOOKUP_LIMIT = 100
PEOPLE_RESULT_LIMIT = 40
# Newest shared items listed under each person.
ITEMS_PER_PERSON = 24


class PublicStudyItem(BaseModel):
    # forbid: a field added here by mistake fails loudly instead of leaking.
    model_config = ConfigDict(extra="forbid")

    id: str
    study_type: StudyType
    title: str
    preview: str
    tags: list[str] = Field(default_factory=list)
    username: str
    published_at: Optional[str] = None
    created_at: str


class PublicUser(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str
    items: list[PublicStudyItem] = Field(default_factory=list)


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


def _matches_query(query: str, *values: object) -> bool:
    normalized_query = query.strip().lower().lstrip("#")
    if not normalized_query:
        return True

    haystack = " ".join(
        [
            text
            for value in values
            for text in ([str(value)] if not isinstance(value, list) else [str(item) for item in value])
        ]
    ).lower()
    return normalized_query in haystack


def _fetch_public_rows(
    table_name: str, columns: str, limit: int = 100, user_ids: Optional[list[str]] = None
) -> list[dict]:
    query = get_supabase().table(table_name).select(columns).eq("is_public", True)
    if user_ids is not None:
        query = query.in_("user_id", user_ids)
    response = query.order("published_at", desc=True).limit(limit).execute()
    return response.data or []


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


def _published_at_for(row: dict) -> str:
    return str(row.get("published_at") or row.get("created_at") or "")


_COLUMNS = {
    # published_by is left out on purpose: it can hold an old name, and search must not match on it.
    "notes": "id, user_id, title, content, tags, created_at, is_public, published_at, study_type",
    "flashcards": "id, user_id, title, front, back, tags, created_at, is_public, published_at, study_type",
    "summaries": "id, user_id, title, content, tags, created_at, is_public, published_at, study_type",
}


def _find_items(query: str = "") -> list[_Found]:
    """The newest shared items that match a topic search."""
    rows = {table: _fetch_public_rows(table, columns) for table, columns in _COLUMNS.items()}
    user_ids = [
        _as_text(row.get("user_id"))
        for table_rows in rows.values()
        for row in table_rows
        if _as_text(row.get("user_id"))
    ]
    return _build_items(rows, _profile_lookup(user_ids), query)[:80]


def _build_items(rows: dict[str, list[dict]], profiles: dict[str, dict], query: str = "") -> list[_Found]:
    notes, flashcards, summaries = rows["notes"], rows["flashcards"], rows["summaries"]
    items: list[_Found] = []

    for row in notes:
        title = _as_text(row.get("title"))
        content = _as_text(row.get("content"))
        tags = _as_tags(row.get("tags"))
        if not title or not _matches_query(query, title, content, tags):
            continue
        user_id = _as_text(row.get("user_id"))
        profile = profiles.get(user_id)
        username = _username_for(profile)
        items.append(
            _Found(
                user_id=user_id,
                item=PublicStudyItem(
                    id=str(row["id"]),
                    study_type="note",
                    title=title,
                    preview=_clip(content),
                    tags=tags,
                    username=username,
                    published_at=_published_at_for(row),
                    created_at=str(row.get("created_at") or ""),
                ),
            )
        )

    for row in flashcards:
        title = _as_text(row.get("title"))
        front = _as_text(row.get("front"))
        back = _as_text(row.get("back"))
        tags = _as_tags(row.get("tags"))
        if not title or not _matches_query(query, title, front, back, tags):
            continue
        user_id = _as_text(row.get("user_id"))
        profile = profiles.get(user_id)
        username = _username_for(profile)
        items.append(
            _Found(
                user_id=user_id,
                item=PublicStudyItem(
                    id=str(row["id"]),
                    study_type="flashcards",
                    title=title,
                    preview=_clip(front or back),
                    tags=tags,
                    username=username,
                    published_at=_published_at_for(row),
                    created_at=str(row.get("created_at") or ""),
                ),
            )
        )

    for row in summaries:
        title = _as_text(row.get("title"))
        content = _as_text(row.get("content"))
        tags = _as_tags(row.get("tags"))
        if not title or not _matches_query(query, title, content, tags):
            continue
        user_id = _as_text(row.get("user_id"))
        profile = profiles.get(user_id)
        username = _username_for(profile)
        items.append(
            _Found(
                user_id=user_id,
                item=PublicStudyItem(
                    id=str(row["id"]),
                    study_type="summary",
                    title=title,
                    preview=_clip(content),
                    tags=tags,
                    username=username,
                    published_at=_published_at_for(row),
                    created_at=str(row.get("created_at") or ""),
                ),
            )
        )

    return sorted(items, key=lambda found: found.item.published_at or found.item.created_at, reverse=True)


@router.get("/topics", response_model=list[PublicStudyItem])
def search_public_topics(
    query: str = Query(default="", max_length=80),
    _user_id: str = Depends(get_current_user_id),
):
    return [found.item for found in _find_items(query)]


def _escape_like(text: str) -> str:
    """Make %, _ and backslash match themselves in an ilike pattern."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


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
    query: str = Query(default="", max_length=80),
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

    user_ids = list(profiles)
    rows = {
        table: _fetch_public_rows(table, columns, limit=500, user_ids=user_ids)
        for table, columns in _COLUMNS.items()
    }

    by_user: dict[str, list[PublicStudyItem]] = {}
    for found in _build_items(rows, profiles):
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
