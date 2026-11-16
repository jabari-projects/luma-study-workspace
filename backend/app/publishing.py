"""Server-side rules for public/private study items (notes, flashcards, summaries).

The client may send published_by, published_at, study_type and updated_at, but
the server ignores them and decides these values itself:

- Creating an item always stores it as private.
- Publishing (is_public -> true) sets published_at (kept if already public),
  published_by = the owner's current username, and the router's fixed
  study_type. A blank title blocks publishing.
- Unpublishing (is_public -> false) clears published_at and published_by.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException, status

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)

CLIENT_CONTROLLED_PUBLISH_FIELDS = ("published_by", "published_at", "study_type", "updated_at")
PUBLISH_TITLE_REQUIRED_MESSAGE = "Please give this study set a title before publishing."
DEFAULT_PUBLISHER_NAME = "Student"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def strip_client_publish_fields(data: dict) -> dict:
    return {key: value for key, value in data.items() if key not in CLIENT_CONTROLLED_PUBLISH_FIELDS}


def _clean_name(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def lookup_publisher_name(user_id: str) -> str:
    """The owner's current username, looked up server-side. Never raises."""
    for table_name in ("users", "profiles"):
        id_column = "id" if table_name == "users" else "user_id"
        try:
            response = (
                get_supabase()
                .table(table_name)
                .select("username")
                .eq(id_column, user_id)
                .limit(1)
                .execute()
            )
            rows = (response.data if response is not None else None) or []
            name = _clean_name(rows[0].get("username")) if rows else None
            if name:
                return name
        except Exception as exc:
            logger.warning(
                "Publisher name lookup failed table=%s user_id=%s (%s)",
                table_name,
                user_id,
                type(exc).__name__,
            )
    return DEFAULT_PUBLISHER_NAME


def require_title_text(title: Optional[str]) -> None:
    """Reject a title that was sent but is only whitespace."""
    if title is not None and not title.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please add a title.")


def build_create_publish_fields(study_type: str) -> dict:
    return {
        "is_public": False,
        "published_at": None,
        "published_by": None,
        "study_type": study_type,
        "updated_at": utc_now_iso(),
    }


def apply_update_publish_rules(
    existing_row: dict,
    updates: dict,
    *,
    user_id: str,
    study_type: str,
    publisher_lookup=None,
) -> dict:
    """Return the update dict with client publish metadata replaced by server values."""
    publisher_lookup = publisher_lookup or lookup_publisher_name
    updates = strip_client_publish_fields(updates)

    if "is_public" in updates and updates["is_public"] is None:
        updates.pop("is_public")

    if updates.get("is_public") is True:
        resulting_title = updates["title"] if "title" in updates else existing_row.get("title")
        if not (isinstance(resulting_title, str) and resulting_title.strip()):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=PUBLISH_TITLE_REQUIRED_MESSAGE
            )
        already_public = bool(existing_row.get("is_public"))
        updates["published_at"] = (
            existing_row.get("published_at") if already_public and existing_row.get("published_at") else utc_now_iso()
        )
        updates["published_by"] = publisher_lookup(user_id) or DEFAULT_PUBLISHER_NAME
        updates["study_type"] = study_type
    elif updates.get("is_public") is False:
        updates["published_at"] = None
        updates["published_by"] = None
    elif bool(existing_row.get("is_public")) and "title" in updates:
        # Still public: a public item may not lose its title.
        title = updates["title"]
        if not (isinstance(title, str) and title.strip()):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=PUBLISH_TITLE_REQUIRED_MESSAGE
            )

    return updates
