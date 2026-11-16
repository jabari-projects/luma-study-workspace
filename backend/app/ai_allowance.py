"""Free AI allowance that follows the email address, not just the account.

Why: counting free AI uses only by user id lets someone delete their account and
sign up again with the same email to get a fresh allowance. This ledger counts
uses per day under a keyed hash of the *normalized* email, so:
- deleting and re-creating an account with the same email doesn't reset it;
- "Name@Gmail.com", "name+study@gmail.com" and "n.a.m.e@gmail.com" share one count.

Rows hold only the keyed hash, the day, the kind of use and a number. Account
deletion keeps them on purpose (they are what stops the reset trick).

What this does NOT do: it can't stop one person from using several different
email addresses. Email verification makes each address cost a real inbox, but
it is not a full anti-abuse system.

Concurrency: increments are compare-and-swap updates, and the routes hold a
per-email in-process lock while a free AI request runs, so parallel requests
can't both squeeze past the limit on one server. With several server
instances, the lock would need to move into the database.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Optional

logger = logging.getLogger(__name__)

TABLE = "ai_allowance_usage"
_GMAIL_DOMAINS = {"gmail.com", "googlemail.com"}
_CAS_RETRIES = 8


def normalize_email(email: Any) -> Optional[str]:
    if not isinstance(email, str):
        return None
    value = email.strip().lower()
    if value.count("@") != 1:
        return None
    local, domain = value.split("@")
    local = local.split("+", 1)[0]
    if domain in _GMAIL_DOMAINS:
        local = local.replace(".", "")
        domain = "gmail.com"
    if not local or not domain:
        return None
    return f"{local}@{domain}"


def allowance_key(secret: str, email: Any) -> Optional[str]:
    normalized = normalize_email(email)
    if normalized is None:
        return None
    message = f"luma-ai-allowance:{normalized}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


class AllowanceLedger:
    def __init__(self, client: Callable[[], Any], day: Callable[[], str] = today):
        self._client = client
        self._day = day
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _table(self):
        return self._client().table(TABLE)

    def _row(self, key: str, usage_type: str) -> Optional[dict]:
        response = (
            self._table()
            .select("*")
            .eq("email_key", key)
            .eq("day", self._day())
            .eq("usage_type", usage_type)
            .execute()
        )
        rows = list(getattr(response, "data", None) or [])
        return rows[0] if rows else None

    def used(self, key: str, usage_type: str) -> Optional[int]:
        """Uses today, or None when the ledger can't be read (callers fail closed)."""
        try:
            row = self._row(key, usage_type)
        except Exception as exc:  # noqa: BLE001
            logger.warning("AI allowance ledger unavailable (%s)", type(exc).__name__)
            return None
        return int(row.get("used") or 0) if row else 0

    def add_use(self, key: str, usage_type: str) -> bool:
        """Count one use. Safe with parallel callers. Returns False if it gave up."""
        for _ in range(_CAS_RETRIES):
            try:
                row = self._row(key, usage_type)
                if row is None:
                    try:
                        self._table().insert(
                            {"email_key": key, "day": self._day(), "usage_type": usage_type, "used": 1}
                        ).execute()
                        return True
                    except Exception:  # noqa: BLE001 - another request inserted first
                        continue
                current = int(row.get("used") or 0)
                updated = (
                    self._table()
                    .update({"used": current + 1})
                    .eq("email_key", key)
                    .eq("day", self._day())
                    .eq("usage_type", usage_type)
                    .eq("used", current)
                    .execute()
                )
                if getattr(updated, "data", None):
                    return True
            except Exception as exc:  # noqa: BLE001
                logger.warning("AI allowance ledger update failed (%s)", type(exc).__name__)
                return False
        logger.warning("AI allowance ledger update gave up after repeated conflicts")
        return False

    @contextmanager
    def single_flight(self, key: str) -> Iterator[bool]:
        """Yield True if no other free AI request for this email is running here."""
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = self._locks[key] = threading.Lock()
        acquired = lock.acquire(blocking=False)
        try:
            yield acquired
        finally:
            if acquired:
                lock.release()
