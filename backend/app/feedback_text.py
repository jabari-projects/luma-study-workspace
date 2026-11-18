"""Fixed copy, comment cleaning and urgent-issue flags for monthly feedback (pure).

Comments are never sent to any outside service. Urgent flags come from local,
deliberately over-inclusive keyword lists: a false alarm costs an admin a few
seconds, a missed security, privacy or accessibility problem costs much more.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Optional

EVENT_TITLE = "If it ain't broke why fix it?!"
EVENT_INTRO = (
    "Help us make Luma better! Answer a few quick questions about what should change. "
    "You can skip this poll. Your answers help us choose what to work on next."
)
PRIVACY_NOTE = "Admins can't see who wrote your answers."
COMMENT_LABEL = "Anything else you'd like us to add or change?"
COMMENT_HINT = "Please don't include passwords or private information."
COMMENT_MAX = 500

URGENT_KINDS = ("security", "accessibility", "privacy")


class CommentTooLong(ValueError):
    pass


_INVISIBLE = re.compile("[​-‏‪-‮⁦-⁩﻿]")


def _is_dropped_control(ch: str) -> bool:
    if ch in ("\n", "\t"):
        return False
    code = ord(ch)
    return code < 0x20 or 0x7F <= code <= 0x9F


def clean_comment(value: Optional[str]) -> Optional[str]:
    """Normalize a student comment. Returns None for empty input.

    Raises CommentTooLong when the cleaned text is over COMMENT_MAX code points.
    The text is otherwise stored as written: it is only ever shown as plain
    text, never as HTML.
    """
    if value is None:
        return None
    text = unicodedata.normalize("NFC", str(value))
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch for ch in text if not _is_dropped_control(ch))
    text = _INVISIBLE.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()
    if not text:
        return None
    if len(text) > COMMENT_MAX:
        raise CommentTooLong()
    return text


_URGENT_WORDS = {
    "security": (
        "password", "hacked", "hack", "someone else's account", "someone elses account",
        "logged in as", "phishing", "scam", "leak", "breach", "stolen", "virus", "malware",
    ),
    "privacy": (
        "private", "personal info", "can see my", "my email", "exposed", "made public",
        "tracking", "doxx", "phone number", "address", "privacy",
    ),
    "accessibility": (
        "screen reader", "blind", "low vision", "dyslex", "colorblind", "color blind", "contrast",
        "keyboard", "font size", "text size", "zoom", "caption", "deaf", "seizure", "flashing",
        "can't read", "cant read", "accessib",
    ),
}


def urgent_flags(text: Optional[str]) -> list[str]:
    if not text:
        return []
    lowered = unicodedata.normalize("NFKC", text).casefold().replace("’", "'")
    return [kind for kind in URGENT_KINDS if any(word in lowered for word in _URGENT_WORDS[kind])]


_TWO_IN_ONE = re.compile(r"\s(and|or)\s|/", re.I)
_NEGATIVE_START = re.compile(r"^\s*(don'?t|do not|stop|remove|keep|no longer)\b", re.I)

LINT_TWO_CHANGES = "Is this two changes in one? Split it."
LINT_NEGATIVE = "Yes must mean 'I want this change'. Write the change itself."


def question_lint(labels: list[str]) -> list[dict]:
    """Warnings only (they never block): the wording rules a machine can spot."""
    out = []
    for position, label in enumerate(labels, start=1):
        text = (label or "").replace("’", "'")
        if _TWO_IN_ONE.search(text):
            out.append({"position": position, "message": LINT_TWO_CHANGES})
        if _NEGATIVE_START.search(text):
            out.append({"position": position, "message": LINT_NEGATIVE})
    return out
