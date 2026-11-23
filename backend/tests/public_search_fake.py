"""A stand-in for public.public_study_search (2026_11_24_subjects.sql) over the fake tables.

Tests only. It follows the SQL function's rules so the API tests can run without a database;
backend/scripts/check_subjects_migration.mjs proves the real function on PGlite.
"""

from __future__ import annotations

import re
from typing import Any, Optional

_TABLES = (("notes", "note"), ("flashcards", "flashcards"), ("summaries", "summary"))


def _like_to_regex(pattern: str) -> re.Pattern:
    """An ilike pattern with backslash escapes, as a case-insensitive regex."""
    out = []
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\" and i + 1 < len(pattern):
            out.append(re.escape(pattern[i + 1]))
            i += 2
            continue
        out.append(".*" if ch == "%" else "." if ch == "_" else re.escape(ch))
        i += 1
    return re.compile("^" + "".join(out) + "$", re.IGNORECASE | re.DOTALL)


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _hay(row: dict, study_type: str) -> str:
    parts = [_text(row.get("title"))]
    if study_type == "flashcards":
        parts += [_text(row.get("front")), _text(row.get("back"))]
        for card in row.get("cards") or []:
            if isinstance(card, dict):
                parts += [_text(card.get("front")), _text(card.get("back"))]
    else:
        parts.append(_text(row.get("content")))
    parts.append(" ".join(row.get("tags") or []))
    return " ".join(part for part in parts if part)


def _shared(tables: dict) -> list[dict]:
    rows = []
    for table, study_type in _TABLES:
        for row in tables.get(table, []):
            if not row.get("is_public") or not _text(row.get("title")).strip():
                continue
            body = (_text(row.get("front")) or _text(row.get("back"))) if study_type == "flashcards" else _text(row.get("content"))[:1000]
            rows.append(
                {
                    "study_type": study_type,
                    "id": row["id"],
                    "user_id": row.get("user_id"),
                    "title": row.get("title"),
                    "body": body,
                    "tags": row.get("tags") or [],
                    "subject_slug": row.get("subject_slug"),
                    "subtopic_slug": row.get("subtopic_slug"),
                    "published_at": row.get("published_at"),
                    "created_at": row.get("created_at"),
                    "_hay": _hay(row, study_type),
                }
            )
    return rows


def _counts(rows: list[dict], key: str, out_key: str) -> list[dict]:
    tally: dict[Optional[str], int] = {}
    for row in rows:
        tally[row[key]] = tally.get(row[key], 0) + 1
    ordered = sorted(tally.items(), key=lambda kv: (-kv[1], kv[0] is None, kv[0] or ""))
    return [{out_key: value, "count": n} for value, n in ordered]


def public_study_search(tables: dict, params: dict) -> dict:
    pattern = params.get("p_pattern")
    regex = _like_to_regex(pattern) if pattern else None
    pairs = params.get("p_match_pairs") or []
    subject, subtopic, study_type = params.get("p_subject"), params.get("p_subtopic"), params.get("p_type")
    user_ids = params.get("p_user_ids")
    limit = max(min(int(params.get("p_limit") or 30), 500), 0)
    offset = max(int(params.get("p_offset") or 0), 0)

    def pair_match(row: dict) -> bool:
        return any(
            pair.get("subject") == row["subject_slug"]
            and (pair.get("subtopic") is None or pair.get("subtopic") == row["subtopic_slug"])
            for pair in pairs
        )

    matched = [
        row
        for row in _shared(tables)
        if (user_ids is None or row["user_id"] in user_ids)
        and (regex is None or regex.match(row["_hay"]) or pair_match(row))
    ]
    chosen = [
        row
        for row in matched
        if (subject is None or row["subject_slug"] == subject)
        and (subtopic is None or row["subtopic_slug"] == subtopic)
        and (study_type is None or row["study_type"] == study_type)
    ]
    chosen.sort(key=lambda row: (str(row["published_at"] or ""), str(row["created_at"] or ""), str(row["id"])), reverse=True)
    page = [{k: v for k, v in row.items() if k != "_hay"} for row in chosen[offset : offset + limit]]
    of_type = [row for row in matched if study_type is None or row["study_type"] == study_type]
    in_subject = [row for row in matched if (subject is None or row["subject_slug"] == subject) and (subtopic is None or row["subtopic_slug"] == subtopic)]
    return {
        "total": len(chosen),
        "rows": page,
        "subjects": _counts(of_type, "subject_slug", "slug"),
        "subtopics": [] if subject is None else _counts([row for row in of_type if row["subject_slug"] == subject], "subtopic_slug", "slug"),
        "types": _counts(in_subject, "study_type", "type"),
    }
