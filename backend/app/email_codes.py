"""Short email codes (6 digits).

Two uses:
- ``signup``: a pending signup. No account exists yet. The row holds the
  chosen username and the argon2id hash of the chosen password, plus a digest
  of a random "signup ticket" that only the browser which started the signup
  knows. The account is created when the code AND the ticket match, so:
    * nobody can claim an email before its owner (no account exists until the
      inbox owner enters the code), and
    * a code an attacker triggers can't be used from the owner's browser to
      finish the attacker's signup (the ticket wouldn't match).
- ``verify_email``: an existing account (older signups, or after changing the
  email) proves its current address. The code is bound to the user AND the
  address it was sent to, so it can't verify a different address later.

How codes are kept safe:
- Only an HMAC-SHA256 digest is stored, keyed with a server secret and bound to
  the purpose, the subject (user or ticket) and the address.
- A code works for CODE_TTL_SECONDS, once, and only while it is the newest one
  for its subject: a new code retires older unused ones.
- Wrong tries are counted per code with compare-and-swap updates, so parallel
  guesses can't beat MAX_ATTEMPTS; using a code is a conditional update too.
- Sending is limited: a cooldown per subject, and hourly/daily caps per subject
  and per inbox (so many signups for one address can't flood that inbox).

Codes, tickets and addresses are never logged.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

TABLE = "email_codes"
PURPOSE_VERIFY_EMAIL = "verify_email"
PURPOSE_SIGNUP = "signup"

CODE_LENGTH = 6
CODE_TTL_SECONDS = 10 * 60
MAX_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60
# Per signup (ticket) or per account.
HOURLY_SEND_CAP = 5
DAILY_SEND_CAP = 10
# Per inbox, across all signups and accounts. Looser on purpose: a stranger
# making signups for someone else's address must not be able to use up that
# person's own allowance easily (signups are also limited per IP).
INBOX_HOURLY_CAP = 20
INBOX_DAILY_CAP = 50
_CAS_RETRIES = 25


@dataclass(frozen=True)
class IssueResult:
    status: str  # "ok" | "cooldown" | "cap" | "missing"
    retry_after: int = 0


@dataclass(frozen=True)
class CheckResult:
    status: str  # "ok" | "incorrect" | "expired" | "locked"
    row: Optional[dict] = None


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _parse(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def generate_code() -> str:
    return f"{secrets.randbelow(10 ** CODE_LENGTH):0{CODE_LENGTH}d}"


def generate_ticket() -> str:
    return secrets.token_urlsafe(24)


def ticket_digest(ticket: str) -> str:
    return hashlib.sha256(f"luma-signup-ticket:{ticket}".encode("utf-8")).hexdigest()


def normalize_code(raw: Any) -> str:
    """Keep digits only, so pasted codes like "123 456" or "123-456" work."""
    if not isinstance(raw, str):
        return ""
    return "".join(ch for ch in raw if ch.isdigit())[: CODE_LENGTH + 1]


def code_digest(secret: str, purpose: str, subject: str, email: str, code: str) -> str:
    message = f"luma-email-code:{purpose}:{subject}:{email}:{code}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


class EmailCodeStore:
    """Issue and check codes. ``client`` returns a Supabase-style client."""

    def __init__(self, client: Callable[[], Any], secret: Callable[[], str], clock: Callable[[], datetime] = utcnow):
        self._client = client
        self._secret = secret
        self._clock = clock
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    # ---------- plumbing ----------

    def _lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = self._locks[key] = threading.Lock()
            return lock

    def _table(self):
        return self._client().table(TABLE)

    def _select(self, filters: dict, since: Optional[datetime] = None, active_only: bool = False) -> list[dict]:
        query = self._table().select("*")
        for column, value in filters.items():
            query = query.eq(column, value)
        if since is not None:
            query = query.gte("created_at", _iso(since))
        if active_only:
            query = query.is_("consumed_at", "null").is_("superseded_at", "null")
        response = query.execute()
        return list(getattr(response, "data", None) or [])

    def _supersede(self, filters: dict) -> None:
        query = self._table().update({"superseded_at": _iso(self._clock())})
        for column, value in filters.items():
            query = query.eq(column, value)
        query.is_("consumed_at", "null").is_("superseded_at", "null").execute()

    @staticmethod
    def _created_times(rows: list[dict]) -> list[datetime]:
        return sorted(t for t in (_parse(r.get("created_at")) for r in rows) if t is not None)

    def _limit(self, subject_rows: list[dict], inbox_rows: list[dict]) -> Optional[IssueResult]:
        now = self._clock()
        mine = self._created_times(subject_rows)
        if mine:
            since_last = (now - mine[-1]).total_seconds()
            if since_last < RESEND_COOLDOWN_SECONDS:
                return IssueResult("cooldown", max(1, int(RESEND_COOLDOWN_SECONDS - since_last) + 1))
        for times, hourly, daily in (
            (mine, HOURLY_SEND_CAP, DAILY_SEND_CAP),
            (self._created_times(inbox_rows), INBOX_HOURLY_CAP, INBOX_DAILY_CAP),
        ):
            last_hour = [t for t in times if (now - t).total_seconds() < 3600]
            if len(last_hour) >= hourly:
                return IssueResult("cap", max(1, int(3600 - (now - last_hour[0]).total_seconds()) + 1))
            if len(times) >= daily:
                return IssueResult("cap", max(1, int(86400 - (now - times[0]).total_seconds()) + 1))
        return None

    def _insert(self, row: dict) -> None:
        now = self._clock()
        self._table().insert(
            {
                **row,
                "created_at": _iso(now),
                "expires_at": _iso(now + timedelta(seconds=CODE_TTL_SECONDS)),
                "attempts": 0,
            }
        ).execute()

    def _check_row(self, filters: dict, subject: str, email: str, purpose: str, raw_code: Any) -> CheckResult:
        code = normalize_code(raw_code)
        for _ in range(_CAS_RETRIES):
            rows = self._select(filters, active_only=True)
            if not rows:
                return CheckResult("incorrect")
            row = max(rows, key=lambda r: _parse(r.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc))
            expires = _parse(row.get("expires_at"))
            if expires is None or self._clock() >= expires:
                return CheckResult("expired")
            attempts = int(row.get("attempts") or 0)
            if attempts >= MAX_ATTEMPTS:
                return CheckResult("locked")

            expected = row.get("code_digest") or ""
            given = code_digest(self._secret(), purpose, subject, email, code) if len(code) == CODE_LENGTH else ""
            if given and hmac.compare_digest(expected, given):
                used = (
                    self._table()
                    .update({"consumed_at": _iso(self._clock())})
                    .eq("id", row["id"])
                    .is_("consumed_at", "null")
                    .is_("superseded_at", "null")
                    .execute()
                )
                return CheckResult("ok", row) if getattr(used, "data", None) else CheckResult("incorrect")

            bumped = (
                self._table()
                .update({"attempts": attempts + 1})
                .eq("id", row["id"])
                .eq("attempts", attempts)
                .execute()
            )
            if getattr(bumped, "data", None):
                return CheckResult("locked" if attempts + 1 >= MAX_ATTEMPTS else "incorrect")
            # Someone else changed the row first; read it again.
        logger.warning("Email code check gave up after repeated conflicts")
        return CheckResult("incorrect")

    # ---------- existing accounts ----------

    def issue_for_user(self, user_id: str, email: str, code: str) -> IssueResult:
        """New code for an existing account and its current address."""
        with self._lock_for(f"user:{user_id}"):
            day_ago = self._clock() - timedelta(days=1)
            subject_rows = self._select({"user_id": user_id, "purpose": PURPOSE_VERIFY_EMAIL}, since=day_ago)
            inbox_rows = self._select({"email": email}, since=day_ago)
            limited = self._limit(subject_rows, inbox_rows)
            if limited:
                return limited
            self._supersede({"user_id": user_id, "purpose": PURPOSE_VERIFY_EMAIL})
            self._insert(
                {
                    "user_id": user_id,
                    "purpose": PURPOSE_VERIFY_EMAIL,
                    "email": email,
                    "code_digest": code_digest(self._secret(), PURPOSE_VERIFY_EMAIL, user_id, email, code),
                }
            )
            return IssueResult("ok")

    def retire_for_user(self, user_id: str) -> None:
        """Stop every unused code for this account (used when the email changes)."""
        with self._lock_for(f"user:{user_id}"):
            self._supersede({"user_id": user_id, "purpose": PURPOSE_VERIFY_EMAIL})

    def check_for_user(self, user_id: str, email: str, raw_code: Any) -> CheckResult:
        return self._check_row(
            {"user_id": user_id, "purpose": PURPOSE_VERIFY_EMAIL, "email": email},
            user_id,
            email,
            PURPOSE_VERIFY_EMAIL,
            raw_code,
        )

    # ---------- pending signups ----------

    def issue_signup(
        self, email: str, ticket: str, code: str, password_hash: str, username: str
    ) -> IssueResult:
        """Start (or restart) a pending signup for this browser's ticket."""
        digest = ticket_digest(ticket)
        with self._lock_for(f"signup:{email}"):
            day_ago = self._clock() - timedelta(days=1)
            subject_rows = self._select({"purpose": PURPOSE_SIGNUP, "email": email, "ticket_digest": digest}, since=day_ago)
            inbox_rows = self._select({"email": email}, since=day_ago)
            limited = self._limit(subject_rows, inbox_rows)
            if limited:
                return limited
            self._supersede({"purpose": PURPOSE_SIGNUP, "email": email, "ticket_digest": digest})
            self._insert(
                {
                    "user_id": None,
                    "purpose": PURPOSE_SIGNUP,
                    "email": email,
                    "ticket_digest": digest,
                    "pending_password_hash": password_hash,
                    "pending_username": username,
                    "code_digest": code_digest(self._secret(), PURPOSE_SIGNUP, digest, email, code),
                }
            )
            return IssueResult("ok")

    def reissue_signup(self, email: str, ticket: str, code: str) -> IssueResult:
        """New code for a pending signup, keeping its username and password."""
        digest = ticket_digest(ticket)
        rows = [
            r
            for r in self._select({"purpose": PURPOSE_SIGNUP, "email": email, "ticket_digest": digest},
                                  since=self._clock() - timedelta(days=1))
            if not r.get("consumed_at")
        ]
        if not rows:
            return IssueResult("missing")
        latest = max(rows, key=lambda r: _parse(r.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc))
        return self.issue_signup(
            email, ticket, code, latest.get("pending_password_hash") or "", latest.get("pending_username") or ""
        )

    def check_signup(self, email: str, ticket: str, raw_code: Any) -> CheckResult:
        digest = ticket_digest(ticket)
        return self._check_row(
            {"purpose": PURPOSE_SIGNUP, "email": email, "ticket_digest": digest},
            digest,
            email,
            PURPOSE_SIGNUP,
            raw_code,
        )
