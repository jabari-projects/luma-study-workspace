"""Hide secrets and personal details in anything that gets logged or printed."""

from __future__ import annotations

import logging
import re
import threading

_known: set[str] = set()
_lock = threading.Lock()

HIDDEN = "[hidden]"

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"postgres(?:ql)?://[^\s'\"<>]+", re.I), "postgres://" + HIDDEN),
    (re.compile(r"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}"), HIDDEN),
    (re.compile(r"sb_(?:secret|publishable)_[A-Za-z0-9_-]+"), HIDDEN),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"), "Bearer " + HIDDEN),
    (
        re.compile(
            r"(?i)\b(password|passphrase|pgpassword|passwd|pwd|secret|service_key|apikey|api_key|authorization)"
            r"(\"?'?\s*[:=]\s*\"?'?)([^\s\"',;}]+)"
        ),
        r"\1\2" + HIDDEN,
    ),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[email]"),
]


def register_secret(value: str | None) -> None:
    """Remember an exact secret so it is hidden wherever it appears."""
    if value and len(value) >= 4:
        with _lock:
            _known.add(value)


def redact(text: object) -> str:
    out = str(text)
    with _lock:
        known = sorted(_known, key=len, reverse=True)
    for value in known:
        out = out.replace(value, HIDDEN)
    for pattern, repl in _PATTERNS:
        out = pattern.sub(repl, out)
    return out


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = None
        if record.exc_info:
            # Exception text from network or database libraries never reaches a log.
            record.exc_info = None
            record.exc_text = None
        return True
