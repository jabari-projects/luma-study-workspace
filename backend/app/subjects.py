"""The subject list (subjects -> subtopics) students pick for notes, decks and summaries.

One file holds the list: app/data/subjects.json. It is loaded and checked once when the app
starts, so a broken file stops the app (and the tests) instead of failing quietly.

- Slugs never change and are never deleted (app/data/subjects.lock.txt lists every one ever
  shipped). Names may be reworded. `"retired": true` hides an entry from the picker, but rows
  that use it stay valid.
- GET /subjects sends the file to the website (no sign-in: it is a plain list, no student data).
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

DATA_FILE = Path(__file__).resolve().parent / "data" / "subjects.json"
LOCK_FILE = Path(__file__).resolve().parent / "data" / "subjects.lock.txt"

SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
MAX_SLUG_LENGTH = 40
MIN_SUBTOPICS = 5
MAX_SUBTOPICS = 24

UNKNOWN_SUBJECT = "Pick a subject from the list."
SUBJECT_FIRST = "Pick a subject first."
UNKNOWN_SUBTOPIC = "Pick a subtopic from the list for this subject."


class SubjectListError(ValueError):
    """subjects.json is not shaped the way the app needs."""


# Search words, folded the same way everywhere (this file, public_search.py, the SQL function,
# the fake API and the website's picker): lower case, "." and "'" dropped (so "U.S." is "us" and
# "Newton's" is "newtons"), anything else that isn't a letter or digit becomes a space.
_FOLD_DROP = re.compile(r"[.'’]")
_FOLD_SPACE = re.compile(r"[\W_]+")
# Small words that mean no subject on their own ("the", "and" would match half the list).
STOP_WORDS = frozenset({"a", "an", "and", "at", "by", "for", "in", "is", "of", "on", "or", "the", "to", "with"})


def fold(text: str) -> str:
    return " ".join(_FOLD_SPACE.sub(" ", _FOLD_DROP.sub("", text.lower())).split())


def word_needle(folded: str) -> str:
    """What a folded search word must find inside " " + folded text + " ".

    Short words (1-2 letters, like "us" or "ap") must be a whole word; longer ones the start of
    a word ("hist" finds "history", "art" never finds "earth").
    """
    return f" {folded} " if len(folded) < 3 else f" {folded}"


def _check_slug(slug: Any, where: str) -> str:
    if not isinstance(slug, str) or len(slug) > MAX_SLUG_LENGTH or not SLUG_RE.match(slug):
        raise SubjectListError(f"bad slug {slug!r} in {where}")
    return slug


def _check_name(name: Any, where: str) -> str:
    if not isinstance(name, str) or not name.strip() or name != name.strip():
        raise SubjectListError(f"bad name {name!r} in {where}")
    return name


def load_subject_list(raw: bytes) -> dict:
    """Parse and check the subject list. Raises SubjectListError with the first problem."""
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("version"), int) or isinstance(data.get("version"), bool):
        raise SubjectListError("version must be a whole number")
    groups = data.get("groups")
    subjects = data.get("subjects")
    if not isinstance(groups, list) or not groups or not isinstance(subjects, list) or not subjects:
        raise SubjectListError("groups and subjects must be lists")
    group_slugs: list[str] = []
    for group in groups:
        group_slugs.append(_check_slug(group.get("slug"), "groups"))
        _check_name(group.get("name"), f"group {group.get('slug')}")
    if len(set(group_slugs)) != len(group_slugs):
        raise SubjectListError("group slugs repeat")
    seen_slugs: set[str] = set()
    seen_names: set[str] = set()
    used_groups: set[str] = set()
    for subject in subjects:
        slug = _check_slug(subject.get("slug"), "subjects")
        if slug in seen_slugs:
            raise SubjectListError(f"subject slug {slug} repeats")
        seen_slugs.add(slug)
        name = _check_name(subject.get("name"), f"subject {slug}")
        if name.lower() in seen_names:
            raise SubjectListError(f"subject name {name} repeats")
        seen_names.add(name.lower())
        if subject.get("group") not in group_slugs:
            raise SubjectListError(f"subject {slug} has an unknown group")
        used_groups.add(subject["group"])
        aliases = subject.get("aliases", [])
        if not isinstance(aliases, list) or any(not isinstance(a, str) or a != a.lower() or not a.strip() for a in aliases):
            raise SubjectListError(f"subject {slug} aliases must be lower case words")
        subtopics = subject.get("subtopics")
        if not isinstance(subtopics, list) or not MIN_SUBTOPICS <= len(subtopics) <= MAX_SUBTOPICS:
            raise SubjectListError(f"subject {slug} needs {MIN_SUBTOPICS} to {MAX_SUBTOPICS} subtopics")
        sub_slugs: set[str] = set()
        for subtopic in subtopics:
            sub = _check_slug(subtopic.get("slug"), f"subject {slug}")
            if sub in sub_slugs:
                raise SubjectListError(f"subtopic {slug}/{sub} repeats")
            sub_slugs.add(sub)
            _check_name(subtopic.get("name"), f"subtopic {slug}/{sub}")
            sub_aliases = subtopic.get("aliases", [])
            if not isinstance(sub_aliases, list) or any(
                not isinstance(a, str) or a != a.lower() or not a.strip() for a in sub_aliases
            ):
                raise SubjectListError(f"subtopic {slug}/{sub} aliases must be lower case words")
    if set(group_slugs) != used_groups:
        raise SubjectListError("every group needs at least one subject")
    return data


_RAW = DATA_FILE.read_bytes()
SUBJECT_LIST: dict = load_subject_list(_RAW)
SUBJECTS_ETAG = hashlib.sha256(_RAW).hexdigest()[:16]

_SUBJECTS: dict[str, dict] = {subject["slug"]: subject for subject in SUBJECT_LIST["subjects"]}
_SUBTOPICS: dict[str, dict[str, dict]] = {
    subject["slug"]: {subtopic["slug"]: subtopic for subtopic in subject["subtopics"]} for subject in SUBJECT_LIST["subjects"]
}


def subject_exists(slug: Optional[str]) -> bool:
    """Retired subjects count as existing: rows that use them stay valid."""
    return isinstance(slug, str) and slug in _SUBJECTS


def subtopic_exists(subject: Optional[str], subtopic: Optional[str]) -> bool:
    return isinstance(subject, str) and isinstance(subtopic, str) and subtopic in _SUBTOPICS.get(subject, {})


def check_pair(subject: Optional[str], subtopic: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """The pair as stored, or ValueError with a message a student can read."""
    if subject is None:
        if subtopic is not None:
            raise ValueError(SUBJECT_FIRST)
        return None, None
    if not subject_exists(subject):
        raise ValueError(UNKNOWN_SUBJECT)
    if subtopic is not None and not subtopic_exists(subject, subtopic):
        raise ValueError(UNKNOWN_SUBTOPIC)
    return subject, subtopic


def _folded_words(entry: dict) -> str:
    """Name and aliases, folded, each padded with spaces, for word_needle()."""
    return "".join(f" {fold(text)} " for text in [entry["name"], *entry.get("aliases", [])])


# (subject slug, its folded words, [(subtopic slug, its folded words)]) for search.
_SEARCH_INDEX = [
    (subject["slug"], _folded_words(subject), [(sub["slug"], _folded_words(sub)) for sub in subject["subtopics"]])
    for subject in SUBJECT_LIST["subjects"]
]


def subjects_matching(word: str) -> list[tuple[str, Optional[str]]]:
    """(subject, subtopic) pairs one search word points at, by name or alias, for Discover.

    The word must be a whole word (1-2 letters) or the start of a word (3+) in a name or alias,
    so "art" finds Art but not "eARTh", and "us" finds U.S. history. A subject match is
    (subject, None): every item in that subject. Small words like "the" match nothing.
    """
    folded = fold(word)
    if not folded or folded in STOP_WORDS:
        return []
    needle = word_needle(folded)
    pairs: list[tuple[str, Optional[str]]] = []
    for slug, words, subtopics in _SEARCH_INDEX:
        if needle in words:
            pairs.append((slug, None))
            continue
        pairs.extend((slug, sub) for sub, sub_words in subtopics if needle in sub_words)
    return pairs


SUBJECT_FIELDS = ("subject_slug", "subtopic_slug")


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=message)


def checked_create_pair(subject: Optional[str], subtopic: Optional[str]) -> dict:
    """The subject columns for a new item. 422 when not on the list.

    Nothing when no subject was picked, so the insert has the same shape as before this
    feature (the columns default to null).
    """
    try:
        subject, subtopic = check_pair(subject, subtopic)
    except ValueError as exc:
        raise _unprocessable(str(exc))
    if subject is None:
        return {}
    return {"subject_slug": subject, "subtopic_slug": subtopic}


def check_sent_subject(updates: dict) -> None:
    """Checks what an update sends that doesn't depend on the stored row (422 when wrong)."""
    if "subject_slug" in updates:
        try:
            check_pair(updates["subject_slug"], updates.get("subtopic_slug"))
        except ValueError as exc:
            raise _unprocessable(str(exc))


def subject_changes(updates: dict, stored_subject: Optional[str]) -> dict:
    """The update with its subject fields settled against the row being written.

    - both sent: both stored (null clears);
    - only subject_slug sent: the subtopic is cleared (an old subtopic may not fit the new subject);
    - only subtopic_slug sent: it must belong to the stored subject;
    - neither sent (old websites): nothing about the subject changes.
    """
    has_subject = "subject_slug" in updates
    has_subtopic = "subtopic_slug" in updates
    if has_subject and not has_subtopic:
        return {**updates, "subtopic_slug": None}
    if has_subtopic and not has_subject:
        try:
            check_pair(stored_subject, updates["subtopic_slug"])
        except ValueError as exc:
            raise _unprocessable(str(exc))
    return updates


router = APIRouter(tags=["subjects"])


@router.get("/subjects")
def get_subjects(request: Request):
    etag = f'"{SUBJECTS_ETAG}"'
    headers = {"ETag": etag, "Cache-Control": "public, max-age=86400"}
    wanted = [tag.strip() for tag in request.headers.get("if-none-match", "").split(",")]
    if etag in wanted or f"W/{etag}" in wanted:
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=SUBJECT_LIST, headers=headers)
