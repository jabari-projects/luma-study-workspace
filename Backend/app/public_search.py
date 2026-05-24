from typing import Literal, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .supabase_client import get_supabase

router = APIRouter(prefix="/public", tags=["public"])
StudyType = Literal["note", "flashcards", "summary"]


class PublicStudyItem(BaseModel):
    id: str
    study_type: StudyType
    title: str
    preview: str
    tags: list[str] = Field(default_factory=list)
    user_id: str
    username: str
    display_name: Optional[str] = None
    published_at: Optional[str] = None
    published_by: Optional[str] = None
    created_at: str


class PublicUser(BaseModel):
    id: str
    username: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    public_count: int
    items: list[PublicStudyItem] = Field(default_factory=list)


def _as_text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _as_tags(value: object) -> list[str]:
    if not isinstance(value, list):
        return []

    return [str(tag) for tag in value if str(tag).strip()]


def _clip(value: str, limit: int = 220) -> str:
    normalized = " ".join(value.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 3].rstrip()}..."


def _matches_query(query: str, *values: object) -> bool:
    normalized_query = query.strip().lower()
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


def _fetch_public_rows(table_name: str, columns: str, limit: int = 100) -> list[dict]:
    response = (
        get_supabase()
        .table(table_name)
        .select(columns)
        .eq("is_public", True)
        .order("published_at", desc=True)
        .limit(limit)
        .execute()
    )
    return response.data or []


def _profile_lookup(user_ids: list[str]) -> dict[str, dict]:
    unique_user_ids = list(dict.fromkeys(user_ids))
    if not unique_user_ids:
        return {}

    response = (
        get_supabase()
        .table("profiles")
        .select("user_id, username, display_name, avatar_url")
        .in_("user_id", unique_user_ids)
        .execute()
    )
    return {row["user_id"]: row for row in (response.data or []) if row.get("user_id")}


def _username_for(profile: Optional[dict], user_id: str, published_by: object = None) -> str:
    if isinstance(published_by, str) and published_by.strip():
        return published_by.strip()
    if profile and isinstance(profile.get("username"), str) and profile["username"].strip():
        return profile["username"]
    return f"student-{user_id[:8]}"


def _published_at_for(row: dict) -> str:
    return str(row.get("published_at") or row.get("created_at") or "")


def _build_items(query: str = "") -> list[PublicStudyItem]:
    notes = _fetch_public_rows(
        "notes",
        "id, user_id, title, content, tags, created_at, is_public, published_at, published_by, study_type",
    )
    flashcards = _fetch_public_rows(
        "flashcards",
        "id, user_id, title, front, back, tags, created_at, is_public, published_at, published_by, study_type",
    )
    summaries = _fetch_public_rows(
        "summaries",
        "id, user_id, title, content, created_at, is_public, published_at, published_by, study_type",
    )

    user_ids = [
        _as_text(row.get("user_id"))
        for row in [*notes, *flashcards, *summaries]
        if _as_text(row.get("user_id"))
    ]
    profiles = _profile_lookup(user_ids)
    items: list[PublicStudyItem] = []

    for row in notes:
        title = _as_text(row.get("title"))
        content = _as_text(row.get("content"))
        tags = _as_tags(row.get("tags"))
        if not title or not _matches_query(query, title, content, tags, row.get("published_by")):
            continue
        user_id = _as_text(row.get("user_id"))
        profile = profiles.get(user_id)
        username = _username_for(profile, user_id, row.get("published_by"))
        items.append(
            PublicStudyItem(
                id=str(row["id"]),
                study_type="note",
                title=title,
                preview=_clip(content),
                tags=tags,
                user_id=user_id,
                username=username,
                display_name=profile.get("display_name") if profile else None,
                published_at=_published_at_for(row),
                published_by=username,
                created_at=str(row.get("created_at") or ""),
            )
        )

    for row in flashcards:
        title = _as_text(row.get("title"))
        front = _as_text(row.get("front"))
        back = _as_text(row.get("back"))
        tags = _as_tags(row.get("tags"))
        if not title or not _matches_query(query, title, front, back, tags, row.get("published_by")):
            continue
        user_id = _as_text(row.get("user_id"))
        profile = profiles.get(user_id)
        username = _username_for(profile, user_id, row.get("published_by"))
        items.append(
            PublicStudyItem(
                id=str(row["id"]),
                study_type="flashcards",
                title=title,
                preview=_clip(front or back),
                tags=tags,
                user_id=user_id,
                username=username,
                display_name=profile.get("display_name") if profile else None,
                published_at=_published_at_for(row),
                published_by=username,
                created_at=str(row.get("created_at") or ""),
            )
        )

    for row in summaries:
        title = _as_text(row.get("title"))
        content = _as_text(row.get("content"))
        if not title or not _matches_query(query, title, content, row.get("published_by")):
            continue
        user_id = _as_text(row.get("user_id"))
        profile = profiles.get(user_id)
        username = _username_for(profile, user_id, row.get("published_by"))
        items.append(
            PublicStudyItem(
                id=str(row["id"]),
                study_type="summary",
                title=title,
                preview=_clip(content),
                tags=[],
                user_id=user_id,
                username=username,
                display_name=profile.get("display_name") if profile else None,
                published_at=_published_at_for(row),
                published_by=username,
                created_at=str(row.get("created_at") or ""),
            )
        )

    return sorted(items, key=lambda item: item.published_at or item.created_at, reverse=True)[:80]


@router.get("/topics", response_model=list[PublicStudyItem])
def search_public_topics(query: str = Query(default="", max_length=80)):
    return _build_items(query)


@router.get("/users", response_model=list[PublicUser])
def search_public_users(query: str = Query(default="", max_length=80)):
    all_items = _build_items("")
    by_user: dict[str, list[PublicStudyItem]] = {}
    for item in all_items:
        by_user.setdefault(item.user_id, []).append(item)

    profiles = _profile_lookup(list(by_user))
    users: list[PublicUser] = []
    for user_id, items in by_user.items():
        profile = profiles.get(user_id)
        username = _username_for(profile, user_id, items[0].published_by)
        display_name = profile.get("display_name") if profile else None
        if not _matches_query(query, username, display_name or ""):
            continue
        users.append(
            PublicUser(
                id=user_id,
                username=username,
                display_name=display_name,
                avatar_url=profile.get("avatar_url") if profile else None,
                public_count=len(items),
                items=items,
            )
        )

    return sorted(users, key=lambda user: (-user.public_count, user.username.lower()))[:40]
