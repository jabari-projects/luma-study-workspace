"""Maintenance mode: a short, announced break that is safe for students' work.

How it works (see docs/maintenance.md for the owner's version):

- One row in public.maintenance_state holds the phase for every server instance:
  none -> announced -> draining -> active -> checking -> none (reopened).
  Every change is a compare-and-swap on `rev` and writes one maintenance_log row.
- Each process caches that row for MAINTENANCE_CACHE_SECONDS. The cache is refreshed
  lazily, only when a request arrives after it expired. There is no background thread,
  timer or loop: an idle process does nothing.
- MaintenanceMiddleware (pure ASGI, inside CORS so its 503s carry CORS headers) decides
  per request what may pass in each phase. Nothing skips it: no header, query, cookie or
  role. Admins get the same 503 on student routes; only ALWAYS_OPEN paths pass, and the
  admin routes there still need require_admin.
- Each process counts its requests in flight. While a break is on the way, it writes that
  count to public.maintenance_instances (when it changes, at most once a second, and
  always when it drops to 0). AI and other long requests also get a maintenance_jobs row
  for as long as they run, in every phase. Entering maintenance is refused until those
  are 0 (section C.5 of the design).
- Times are stored and sent as UTC. The admin types Chicago wall-clock times; times that
  are skipped or happen twice when clocks change are refused.

Nothing here reads or writes student content. Log details hold codes and counts only.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import socket
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .auth import get_current_user_id, get_jwt_secret_key, require_admin
from .supabase_client import get_supabase, is_supabase_configured

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ constants

PHASES = ("none", "announced", "draining", "active", "checking")
REASONS = ("database_update", "website_update", "backup_check", "other")
CHICAGO = ZoneInfo("America/Chicago")

MAINTENANCE_CACHE_SECONDS = 5.0
DB_CALL_SECONDS = 5.0
REPORT_MIN_INTERVAL_SECONDS = 1.0
HEARTBEAT_FRESH_SECONDS = 120
HEARTBEAT_SILENT_LIMIT_SECONDS = 600
DRAIN_SETTLE_SECONDS = 60  # cache TTL plus the longest normal request
DEFAULT_GRACE_MINUTES = 10
MIN_LEAD_MINUTES = 30
REOPEN_CHECKS_VALID_SECONDS = 30 * 60
RECENTLY_REOPENED_SECONDS = 30 * 60
EDIT_SESSION_TTL_SECONDS = 24 * 60 * 60
EDIT_SESSION_PREFIX = b"luma-edit-session-v1|"
EDIT_SESSION_HEADER = "x-luma-edit-session"
WEBHOOK_RETRY_AFTER_SECONDS = 600
JOB_SLACK_SECONDS = 30



def make_instance_id(render_instance_id: Optional[str] = None, pid: Optional[int] = None) -> str:
    """One id per server PROCESS. Render's instance id alone is not enough: with more than one
    uvicorn worker (WEB_CONCURRENCY) every worker on an instance would share one row and
    overwrite the others' in-flight counts. So the pid and a random part are always added."""
    base = render_instance_id if render_instance_id is not None else os.getenv("RENDER_INSTANCE_ID")
    return f"{base or socket.gethostname()}-{pid if pid is not None else os.getpid()}-{uuid.uuid4().hex[:6]}"


INSTANCE_ID = make_instance_id()
CODE_VERSION = os.getenv("RENDER_GIT_COMMIT", "")

STATE_TABLE = "maintenance_state"
INSTANCES_TABLE = "maintenance_instances"
JOBS_TABLE = "maintenance_jobs"
LOG_TABLE = "maintenance_log"

# Row counts kept at activation and compared before reopening (numbers only).
COUNT_TABLES = ("users", "profiles", "notes", "summaries", "flashcards", "study_sessions")
# The "database" reopen check reads no rows from each of these.
CORE_TABLES = COUNT_TABLES
# The "schema" reopen check: these columns must exist. The student-work columns come from
# 2026_11_19_student_work_versions.sql: without them every save fails, so Luma must not reopen.
REQUIRED_SCHEMA: dict[str, tuple[str, ...]] = {
    "notes": ("id", "user_id", "version", "create_key"),
    "summaries": ("id", "user_id", "version", "create_key"),
    "flashcards": ("id", "user_id", "version", "create_key", "progress_rev"),
    "study_sessions": ("id", "user_id", "version", "create_key"),
    STATE_TABLE: (
        "id", "phase", "rev", "reason", "note", "start_at", "estimated_end_at", "drain_started_at",
        "grace_ends_at", "activated_at", "backup_ref", "counts_at_activation", "checks",
        "checks_passed_at", "reopened_at", "updated_by", "updated_at",
    ),
    INSTANCES_TABLE: ("instance_id", "started_at", "heartbeat_at", "in_flight", "phase_seen", "code_version"),
    JOBS_TABLE: ("job_id", "instance_id", "kind", "started_at", "expected_end_at"),
    LOG_TABLE: ("id", "at", "actor_user_id", "action", "from_phase", "to_phase", "detail"),
}

BACKUP_REF_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")
LOCAL_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")

ACTIVE_MESSAGE = "Luma is taking a short break. Your saved work is safe. Please try again after the break."
DRAINING_MESSAGE = (
    "Luma is getting ready for a short break, so new work can't start right now. "
    "Work you already started can still be saved for a few minutes."
)
UNAVAILABLE_MESSAGE = "We can't reach the break settings right now. Try again in a minute."
STARTING_MESSAGE = "Luma is just starting up and can't save changes yet. Your work is still here. Try again in a minute."
# Retry-After for a process that has not read the break state yet (see state_known).
UNKNOWN_STATE_RETRY_SECONDS = 30
CHANGED_MESSAGE = "Someone else changed the break just now. Look at the page again before you try."
NOT_SAFE_MESSAGE = "It isn't safe to start yet."
TIME_SKIPPED_MESSAGE = "That time is skipped when clocks change. Pick another time."
TIME_TWICE_MESSAGE = "That time happens twice when clocks change. Pick another time."

# ------------------------------------------------------------------ path groups

ALWAYS_OPEN = "always_open"
AI = "ai"
LONG = "long"
CONTENT_WRITE = "content_write"
WEBHOOK = "webhook"
OTHER_WRITE = "other_write"
READ = "read"
EDIT_SESSION = "edit_session"

ALWAYS_OPEN_GETS = frozenset({"/maintenance/status", "/health", "/health/ready", "/robots.txt", "/me", "/me/profile"})
ADMIN_PREFIX = "/admin/maintenance"
# POST /login (not /auth/login: that path doesn't exist) so an admin can sign in during a break.
LOGIN_PATH = "/login"
AI_PATHS = {
    "/api/generate-notes": ("ai_image", 100),
    "/api/notes-from-text": ("ai_notes", 100),
    "/api/summarize": ("ai_summary", 100),
    "/api/transcribe": ("ai_transcribe", 150),
    "/api/import/link": ("link_import", 20),
}
UPLOAD_PATHS = ("/me/avatar", "/me/theme-image")
CONTENT_PREFIXES = ("/notes", "/summaries", "/flashcards", "/study-sessions", "/transcripts")
WEBHOOK_PATH = "/api/stripe-webhook"
READ_METHODS = ("GET", "HEAD")


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + "/")


def classify(method: str, path: str) -> tuple[str, Optional[tuple[str, int]]]:
    """Path group and, for long work, (job kind, deadline seconds)."""
    method = method.upper()
    if method == "OPTIONS":
        return ALWAYS_OPEN, None  # CORS answers real preflights before this runs
    if _under(path, ADMIN_PREFIX):
        return ALWAYS_OPEN, None
    if method in READ_METHODS and path in ALWAYS_OPEN_GETS:
        return ALWAYS_OPEN, None
    if method == "POST" and path == LOGIN_PATH:
        return ALWAYS_OPEN, None
    if method == "POST" and path == "/maintenance/edit-session":
        return EDIT_SESSION, None
    if method == "POST" and path in AI_PATHS:
        return AI, AI_PATHS[path]
    if method == "DELETE" and path == "/me/account":
        return LONG, ("account_deletion", 300)
    if method == "POST" and path in UPLOAD_PATHS:
        return LONG, ("upload", 60)
    if method == "DELETE" and path in UPLOAD_PATHS:
        return LONG, None
    if method == "POST" and path == "/signup":
        return LONG, None
    if method == "POST" and path == WEBHOOK_PATH:
        return WEBHOOK, None
    if method in READ_METHODS:
        return READ, None
    if any(_under(path, prefix) for prefix in CONTENT_PREFIXES):
        return CONTENT_WRITE, None
    return OTHER_WRITE, None


# ------------------------------------------------------------------ time helpers


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_ts(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class TimeChoiceError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code = code
        self.message = message


def chicago_to_utc(local_value: str) -> datetime:
    """Turns a Chicago wall-clock time ("2026-12-01T05:00") into UTC.

    Refuses times that don't exist (spring forward) or happen twice (fall back).
    """
    if not isinstance(local_value, str) or not LOCAL_TIME_RE.match(local_value):
        raise TimeChoiceError("time_invalid", "Pick a day and a time.")
    try:
        naive = datetime.fromisoformat(local_value)
    except ValueError as exc:
        raise TimeChoiceError("time_invalid", "Pick a day and a time.") from exc
    first = naive.replace(tzinfo=CHICAGO, fold=0)
    second = naive.replace(tzinfo=CHICAGO, fold=1)
    first_utc = first.astimezone(timezone.utc)
    if first_utc != second.astimezone(timezone.utc):
        round_trip = first_utc.astimezone(CHICAGO).replace(tzinfo=None)
        if round_trip != naive:
            raise TimeChoiceError("time_skipped", TIME_SKIPPED_MESSAGE)
        raise TimeChoiceError("time_twice", TIME_TWICE_MESSAGE)
    return first_utc


def retry_after_seconds(state: dict, now: datetime) -> int:
    end = parse_ts(state.get("estimated_end_at"))
    if end is None:
        return 900
    return int(min(3600, max(60, math.ceil((end - now).total_seconds()))))


# ------------------------------------------------------------------ edit-session tokens


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _edit_session_mac(payload: bytes) -> bytes:
    key = get_jwt_secret_key().encode("utf-8")
    return hmac.new(key, EDIT_SESSION_PREFIX + payload, hashlib.sha256).digest()


def make_edit_session_token(now: datetime) -> str:
    payload = json.dumps({"iat": int(now.timestamp()), "n": secrets.token_urlsafe(9)}, separators=(",", ":")).encode()
    return f"{_b64(payload)}.{_b64(_edit_session_mac(payload))}"


def edit_session_issued_at(token: Optional[str], now: datetime) -> Optional[datetime]:
    """When a valid, unexpired token was issued; None for anything else."""
    if not token or len(token) > 512 or token.count(".") != 1:
        return None
    payload_text, mac_text = token.split(".", 1)
    try:
        payload = _unb64(payload_text)
        mac = _unb64(mac_text)
    except (ValueError, TypeError):
        return None
    if not hmac.compare_digest(mac, _edit_session_mac(payload)):
        return None
    try:
        issued = int(json.loads(payload)["iat"])
    except (ValueError, KeyError, TypeError):
        return None
    issued_at = datetime.fromtimestamp(issued, timezone.utc)
    if issued_at > now + timedelta(seconds=5) or now - issued_at > timedelta(seconds=EDIT_SESSION_TTL_SECONDS):
        return None
    return issued_at


# ------------------------------------------------------------------ state shape

STATE_DEFAULTS: dict[str, Any] = {
    "id": 1,
    "phase": "none",
    "rev": 0,  # 0 = never read (the table starts at 1)
    "reason": "",
    "note": "",
    "start_at": None,
    "estimated_end_at": None,
    "drain_started_at": None,
    "grace_ends_at": None,
    "activated_at": None,
    "backup_ref": None,
    "counts_at_activation": None,
    "checks": None,
    "checks_passed_at": None,
    "reopened_at": None,
    "updated_by": None,
    "updated_at": None,
}

# Cleared whenever a break is scheduled again, cancelled or reopened.
BREAK_FIELDS = {
    "start_at": None,
    "estimated_end_at": None,
    "drain_started_at": None,
    "grace_ends_at": None,
    "activated_at": None,
    "backup_ref": None,
    "counts_at_activation": None,
    "checks": None,
    "checks_passed_at": None,
}


def normalize_state(row: Optional[dict]) -> dict:
    state = dict(STATE_DEFAULTS)
    if isinstance(row, dict):
        state.update({k: row.get(k, v) for k, v in STATE_DEFAULTS.items()})
    if state.get("phase") not in PHASES:
        state["phase"] = "none"
    return state


def public_status(state: dict, now: datetime) -> dict:
    reopened_at = parse_ts(state.get("reopened_at"))
    recently = bool(
        state["phase"] == "none"
        and reopened_at is not None
        and timedelta(0) <= now - reopened_at < timedelta(seconds=RECENTLY_REOPENED_SECONDS)
    )
    return {
        "phase": state["phase"],
        "rev": int(state.get("rev") or 0),
        "reason": state.get("reason") or "",
        "note": state.get("note") or "",
        "start_at": iso(parse_ts(state.get("start_at"))),
        "estimated_end_at": iso(parse_ts(state.get("estimated_end_at"))),
        "drain_started_at": iso(parse_ts(state.get("drain_started_at"))),
        "grace_ends_at": iso(parse_ts(state.get("grace_ends_at"))),
        "recently_reopened": recently,
        "server_time": iso(now),
    }


# ------------------------------------------------------------------ database access


class MaintenanceStore:
    """Every database call maintenance makes. Small on purpose so tests can share one fake
    database between two simulated instances."""

    def __init__(self, client_getter: Callable[[], Any] = get_supabase, configured: Callable[[], bool] = is_supabase_configured):
        self._client = client_getter
        self.configured = configured

    def _t(self, name: str):
        return self._client().table(name)

    def read_state(self) -> Optional[dict]:
        if not self.configured():
            return None
        rows = self._t(STATE_TABLE).select("*").eq("id", 1).limit(1).execute().data or []
        return rows[0] if rows else None

    def cas_update(self, expected_rev: int, changes: dict) -> Optional[dict]:
        rows = self._t(STATE_TABLE).update(changes).eq("id", 1).eq("rev", expected_rev).execute().data or []
        return rows[0] if rows else None

    def upsert_instance(self, row: dict) -> None:
        self._t(INSTANCES_TABLE).upsert(row, on_conflict="instance_id").execute()

    def list_instances(self) -> list[dict]:
        return self._t(INSTANCES_TABLE).select(",".join(REQUIRED_SCHEMA[INSTANCES_TABLE])).limit(200).execute().data or []

    def insert_job(self, row: dict) -> None:
        self._t(JOBS_TABLE).insert(row).execute()

    def delete_job(self, job_id: str) -> None:
        self._t(JOBS_TABLE).delete().eq("job_id", job_id).execute()

    def list_jobs(self) -> list[dict]:
        return self._t(JOBS_TABLE).select("job_id,instance_id,kind,started_at,expected_end_at").limit(500).execute().data or []

    def insert_log(self, row: dict) -> None:
        self._t(LOG_TABLE).insert(row).execute()

    def list_log(self, limit: int = 20) -> list[dict]:
        return (
            self._t(LOG_TABLE)
            .select("at,action,from_phase,to_phase,detail")
            .order("at", desc=True)
            .limit(limit)
            .execute()
            .data
            or []
        )

    def count_rows(self, table: str) -> int:
        result = self._t(table).select("*", count="exact", head=True).execute()
        count = getattr(result, "count", None)
        if not isinstance(count, int):
            raise RuntimeError("count missing")
        return count

    def probe(self, table: str, columns: tuple[str, ...]) -> None:
        self._t(table).select(",".join(columns)).limit(0).execute()

    def list_bucket_names(self) -> list[str]:
        if not self.configured():
            raise RuntimeError("storage not configured")
        buckets = self._client().storage.list_buckets() or []
        return [str(getattr(b, "name", None) or (b.get("name") if isinstance(b, dict) else "")) for b in buckets]


# ------------------------------------------------------------------ per-process runtime


class MaintenanceUnavailable(Exception):
    """The maintenance tables could not be read or written in time."""


class MaintenanceRuntime:
    """What one server process knows: the cached state and its own requests in flight.

    No timer or background loop is ever started here: work happens only because a request
    arrived or a count changed. Database calls run on a small pool of their own (two
    threads, never the AI pool) and are given DB_CALL_SECONDS at most.
    """

    def __init__(
        self,
        store: Optional[MaintenanceStore] = None,
        instance_id: str = INSTANCE_ID,
        clock: Callable[[], datetime] = utc_now,
        cache_seconds: float = MAINTENANCE_CACHE_SECONDS,
        code_version: str = CODE_VERSION,
    ):
        self.store = store or MaintenanceStore()
        self.instance_id = instance_id
        self.clock = clock
        self.cache_seconds = cache_seconds
        self.code_version = code_version
        self.started_at = clock()
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="maintenance-db")
        self._lock = threading.Lock()
        self._state = normalize_state(None)
        self._checked_at: Optional[datetime] = None
        self._refreshing: Optional[Future] = None
        self._read_failing = False
        # False until this process has read the break state once. Until then it can't know
        # whether a break is on, so the middleware refuses writes (fails closed).
        self._known = False
        self.in_flight = 0
        self._reported_phase = "none"
        self._last_report_mono = -1e9
        self._report_pending = False
        self._report_force = False
        self._report_dirty = False
        self._report_failing = False
        self._job_failing = False

    # ---- running database calls
    def call(self, fn: Callable[[], Any]) -> Any:
        """For sync code (admin routes): run fn on the maintenance pool, 5 s at most."""
        future = self._executor.submit(fn)
        try:
            return future.result(timeout=DB_CALL_SECONDS)
        except Exception as exc:
            future.cancel()
            raise MaintenanceUnavailable(type(exc).__name__) from exc

    async def acall(self, fn: Callable[[], Any]) -> Any:
        future = self._executor.submit(fn)
        try:
            return await asyncio.wait_for(asyncio.wrap_future(future), timeout=DB_CALL_SECONDS)
        except Exception as exc:
            future.cancel()
            raise MaintenanceUnavailable(type(exc).__name__) from exc

    # ---- state cache
    @property
    def state(self) -> dict:
        return self._state

    def _fresh(self, now: datetime) -> bool:
        return self._checked_at is not None and (now - self._checked_at).total_seconds() < self.cache_seconds

    def _refresh_sync(self) -> None:
        try:
            row = self.store.read_state()
        except Exception as exc:  # keep the last known state
            if not self._read_failing:
                logger.warning("Maintenance state could not be read (%s); keeping the last known phase", type(exc).__name__)
            self._read_failing = True
            row = None
            ok = False
        else:
            if self._read_failing:
                logger.info("Maintenance state can be read again")
            self._read_failing = False
            ok = True
        with self._lock:
            self._checked_at = self.clock()
            if ok:
                self._known = True
            if ok and row is not None:
                self._set_state_locked(normalize_state(row))

    def _set_state_locked(self, state: dict) -> None:
        old_phase = self._state["phase"]
        if int(state.get("rev") or 0) < int(self._state.get("rev") or 0):
            # A slow read that started before an admin change must not undo it here.
            # rev only ever goes up (every change is rev + 1).
            return
        self._state = state
        if state["phase"] != old_phase or state["phase"] != self._reported_phase:
            self._want_report_locked(force=True)

    def apply_state(self, row: dict) -> None:
        """Admin transitions update this process's cache right away."""
        with self._lock:
            self._checked_at = self.clock()
            self._known = True
            self._set_state_locked(normalize_state(row))

    @property
    def state_known(self) -> bool:
        """True once this process has read the break state at least once."""
        return self._known

    async def current_state(self) -> dict:
        now = self.clock()
        if self._fresh(now):
            return self._state
        with self._lock:
            future = self._refreshing
            if future is None or future.done():
                future = self._executor.submit(self._refresh_sync)
                self._refreshing = future
        try:
            await asyncio.wait_for(asyncio.wrap_future(future), timeout=DB_CALL_SECONDS)
        except Exception:
            pass  # last known state stays (logged in _refresh_sync)
        return self._state

    def read_fresh(self) -> dict:
        """Reads the row now (admin routes). Raises MaintenanceUnavailable."""
        row = self.call(self.store.read_state)
        if row is None:
            raise MaintenanceUnavailable("no state row")
        self.apply_state(row)
        return normalize_state(row)

    # ---- requests in flight
    def request_started(self) -> None:
        with self._lock:
            self.in_flight += 1
            self._want_report_locked(force=False)

    def request_finished(self) -> None:
        with self._lock:
            self.in_flight = max(0, self.in_flight - 1)
            self._want_report_locked(force=self.in_flight == 0)

    def _want_report_locked(self, force: bool) -> None:
        phase = self._state["phase"]
        if phase == "none" and self._reported_phase == "none":
            return  # nothing planned: no writes at all
        if force:
            self._report_force = True
        if self._report_pending:
            self._report_dirty = True  # the queued write sends the newest count
            return
        self._report_pending = True
        self._executor.submit(self._report_loop)

    def _report_loop(self) -> None:
        """Writes the newest count, at most once a second; a drop to 0 or a phase change
        is written right away. The wait below is one bounded pause (under a second) before
        a write that is already due, never a repeating check: when nothing changes, nothing
        runs."""
        while True:
            with self._lock:
                force = self._report_force
                self._report_force = False
                self._report_dirty = False
            wait = REPORT_MIN_INTERVAL_SECONDS - (time.monotonic() - self._last_report_mono)
            if not force and wait > 0:
                time.sleep(wait)
            self.report_now()
            with self._lock:
                if self._report_dirty or self._report_force:
                    continue
                self._report_pending = False
                return

    def report_now(self) -> None:
        """Writes this instance's row (in flight, heartbeat, phase seen). Sync."""
        with self._lock:
            row = {
                "instance_id": self.instance_id,
                "started_at": iso(self.started_at),
                "heartbeat_at": iso(self.clock()),
                "in_flight": self.in_flight,
                "phase_seen": self._state["phase"],
                "code_version": self.code_version,
            }
        try:
            self.store.upsert_instance(row)
        except Exception as exc:
            if not self._report_failing:
                logger.warning("Maintenance instance report failed (%s)", type(exc).__name__)
            self._report_failing = True
            return
        self._report_failing = False
        with self._lock:
            self._last_report_mono = time.monotonic()
            self._reported_phase = row["phase_seen"]

    def wait_for_reports(self) -> None:
        """Tests: wait until queued instance reports are written."""
        for _ in range(500):
            with self._lock:
                if not self._report_pending:
                    return
            time.sleep(0.01)

    # ---- long jobs
    async def start_job(self, kind: str, deadline_seconds: int) -> Optional[str]:
        job_id = str(uuid.uuid4())
        now = self.clock()
        row = {
            "job_id": job_id,
            "instance_id": self.instance_id,
            "kind": kind,
            "started_at": iso(now),
            "expected_end_at": iso(now + timedelta(seconds=deadline_seconds + JOB_SLACK_SECONDS)),
        }
        try:
            await self.acall(lambda: self.store.insert_job(row))
        except MaintenanceUnavailable as exc:
            # The request still runs; the in-flight count covers it.
            if not self._job_failing:
                logger.warning("Maintenance job row could not be written (%s)", exc)
            self._job_failing = True
            return None
        self._job_failing = False
        return job_id

    async def finish_job(self, job_id: str) -> None:
        try:
            await self.acall(lambda: self.store.delete_job(job_id))
        except MaintenanceUnavailable as exc:
            # A row left behind turns stale at expected_end_at: reported, never blocking.
            logger.warning("Maintenance job row could not be removed (%s)", exc)


_runtime: Optional[MaintenanceRuntime] = None
_runtime_guard = threading.Lock()


def get_runtime() -> MaintenanceRuntime:
    global _runtime
    with _runtime_guard:
        if _runtime is None:
            _runtime = MaintenanceRuntime()
        return _runtime


def set_runtime(runtime: Optional[MaintenanceRuntime]) -> None:
    """Tests: swap in a runtime (a simulated instance or a restarted process)."""
    global _runtime
    with _runtime_guard:
        _runtime = runtime


def writes_paused() -> bool:
    """True during the break (or before this process could read the break state). Routes
    that stay open during a break (like log in) use it to skip optional writes. Uses the
    cached state only: no database call."""
    runtime = get_runtime()
    return (not runtime.state_known) or runtime.state["phase"] in ("active", "checking")


def ordinary_writes_allowed() -> bool:
    """True only when the gate would let an ordinary write (OTHER_WRITE) through right now.
    A read that also tidies up (the feedback poll's monthly drafts and voter-key cleanup) checks
    it, so a read never writes once writes are refused: after the grace time, during the break,
    or before this process could read the break state. Cached state only: no database call."""
    runtime = get_runtime()
    return runtime.state_known and decide(runtime.state, OTHER_WRITE, None, runtime.clock()) is None


# ------------------------------------------------------------------ the gate


def _error_body(state: dict, code: str, message: str, retry_after: int) -> dict:
    return {
        "detail": message,
        "error_code": code,
        "retry_after": retry_after,
        "maintenance": {"phase": state["phase"], "estimated_end_at": iso(parse_ts(state.get("estimated_end_at")))},
    }


def decide(state: dict, group: str, edit_token: Optional[str], now: datetime) -> Optional[tuple[str, str]]:
    """None to let the request through, else (error_code, message) for a 503."""
    phase = state["phase"]
    if group == ALWAYS_OPEN or phase in ("none", "announced"):
        return None
    if phase in ("active", "checking"):
        return ("maintenance_active", ACTIVE_MESSAGE)
    # draining
    grace_ends = parse_ts(state.get("grace_ends_at"))
    grace_over = grace_ends is None or now >= grace_ends
    if group == READ:
        return None
    if group == WEBHOOK:
        # Payment events wait (Stripe sends them again) from DRAIN_SETTLE_SECONDS before the
        # grace ends. Another server whose 5-second copy still says "draining", or whose clock
        # is a little behind, then can't change the database after the break starts.
        settle_from = grace_ends - timedelta(seconds=DRAIN_SETTLE_SECONDS) if grace_ends else None
        if settle_from is None or now >= settle_from:
            return ("maintenance_draining", DRAINING_MESSAGE)
        return None
    if group in (AI, LONG, EDIT_SESSION):
        return ("maintenance_draining", DRAINING_MESSAGE)
    if group == OTHER_WRITE:
        return ("maintenance_draining", DRAINING_MESSAGE) if grace_over else None
    if group == CONTENT_WRITE and not grace_over:
        issued = edit_session_issued_at(edit_token, now)
        drain_started = parse_ts(state.get("drain_started_at"))
        if issued is not None and drain_started is not None and issued <= drain_started:
            return None
    return ("maintenance_draining", DRAINING_MESSAGE)


class MaintenanceMiddleware:
    """Pure ASGI. Added inside CORSMiddleware, so its 503s carry CORS headers."""

    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        runtime = get_runtime()
        group, job = classify(scope.get("method", "GET"), scope.get("path", ""))
        state = await runtime.current_state()
        now = runtime.clock()
        edit_token = None
        if group == CONTENT_WRITE:
            for name, value in scope.get("headers", []):
                if name == EDIT_SESSION_HEADER.encode():
                    edit_token = value.decode("latin-1")
                    break
        blocked = decide(state, group, edit_token, now)
        if blocked is None and not runtime.state_known and group not in (ALWAYS_OPEN, READ):
            # A new process (a deploy, a crash or a cold start) whose first read failed can't
            # tell whether a break is on. Fail closed: reading stays open, changes wait.
            response = JSONResponse(
                status_code=503,
                content={
                    "detail": STARTING_MESSAGE,
                    "error_code": "maintenance_unavailable",
                    "retry_after": UNKNOWN_STATE_RETRY_SECONDS,
                },
            )
            response.headers["Retry-After"] = str(UNKNOWN_STATE_RETRY_SECONDS)
            response.headers["Cache-Control"] = "no-store"
            await response(scope, receive, send)
            return
        phase_headers = [
            (b"x-luma-maintenance", state["phase"].encode()),
            (b"x-luma-maintenance-rev", str(int(state.get("rev") or 0)).encode()),
        ]
        if blocked is not None:
            code, message = blocked
            retry = WEBHOOK_RETRY_AFTER_SECONDS if group == WEBHOOK else retry_after_seconds(state, now)
            response = JSONResponse(status_code=503, content=_error_body(state, code, message, retry))
            response.headers["Retry-After"] = str(retry)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Luma-Maintenance"] = state["phase"]
            response.headers["X-Luma-Maintenance-Rev"] = str(int(state.get("rev") or 0))
            await response(scope, receive, send)
            return

        async def send_with_phase(message):
            if message["type"] == "http.response.start":
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + phase_headers
            await send(message)

        counted = group != ALWAYS_OPEN
        if counted:
            runtime.request_started()
        job_id = None
        try:
            if job is not None:
                job_id = await runtime.start_job(job[0], job[1])
            await self.app(scope, receive, send_with_phase)
        finally:
            if job_id is not None:
                await runtime.finish_job(job_id)
            if counted:
                runtime.request_finished()


# ------------------------------------------------------------------ public routes

maintenance_router = APIRouter(tags=["maintenance"])


@maintenance_router.get("/maintenance/status")
async def maintenance_status():
    runtime = get_runtime()
    state = await runtime.current_state()
    return JSONResponse(content=public_status(state, runtime.clock()), headers={"Cache-Control": "no-store"})


@maintenance_router.post("/maintenance/edit-session")
def start_edit_session(_user_id: str = Depends(get_current_user_id)):
    """Editors ask for this when they open. During the grace period of a drain, only edits
    from sessions that started before the drain may still save. The middleware already
    refuses this route while draining or during the break."""
    now = get_runtime().clock()
    return {"token": make_edit_session_token(now), "issued_at": iso(now)}


# ------------------------------------------------------------------ admin routes

admin_maintenance_router = APIRouter(prefix="/admin/maintenance", tags=["maintenance-admin"])


class RevBody(BaseModel):
    expected_rev: int = Field(..., ge=0)


class ScheduleBody(RevBody):
    start_local: str = Field(..., max_length=20)
    estimated_end_local: str = Field(..., max_length=20)
    reason: Literal["database_update", "website_update", "backup_check", "other"]
    note: str = Field("", max_length=200)


class PostponeBody(RevBody):
    start_local: str = Field(..., max_length=20)
    estimated_end_local: str = Field(..., max_length=20)


class DrainBody(RevBody):
    grace_minutes: int = Field(DEFAULT_GRACE_MINUTES, ge=5, le=30)


class ActivateBody(RevBody):
    backup_ref: Optional[str] = Field(None, max_length=32)
    backup_checked: bool = False


class ChecksBody(RevBody):
    counts_drop_reason: Optional[str] = Field(None, max_length=200)


def _refuse(status: int, code: str, message: str, **extra) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": message, "error_code": code, **extra})


def _unavailable() -> JSONResponse:
    return _refuse(503, "maintenance_unavailable", UNAVAILABLE_MESSAGE)


def _wrong_step(state: dict) -> JSONResponse:
    return _refuse(
        409,
        "maintenance_changed",
        CHANGED_MESSAGE,
        phase=state["phase"],
        rev=int(state.get("rev") or 0),
    )


def _times(start_local: str, end_local: str, now: datetime) -> tuple[datetime, datetime]:
    start = chicago_to_utc(start_local)
    end = chicago_to_utc(end_local)
    if start < now + timedelta(minutes=MIN_LEAD_MINUTES):
        raise TimeChoiceError("time_too_soon", f"Pick a start at least {MIN_LEAD_MINUTES} minutes from now.")
    if end <= start:
        raise TimeChoiceError("time_order", "The end has to be after the start.")
    return start, end


def _write_log(runtime: MaintenanceRuntime, actor: Optional[str], action: str, from_phase: Optional[str], to_phase: Optional[str], detail: dict) -> None:
    row = {
        "at": iso(runtime.clock()),
        "actor_user_id": actor,
        "action": action,
        "from_phase": from_phase,
        "to_phase": to_phase,
        "detail": detail,
    }
    try:
        runtime.call(lambda: runtime.store.insert_log(row))
    except MaintenanceUnavailable as exc:
        logger.warning("Maintenance log row could not be written (%s)", exc)


def _transition(runtime: MaintenanceRuntime, actor: str, state: dict, expected_rev: int, action: str, changes: dict, detail: Optional[dict] = None):
    """CAS on rev; returns the new state, or a 409 response if someone moved it first."""
    now = runtime.clock()
    payload = {**changes, "rev": expected_rev + 1, "updated_by": actor, "updated_at": iso(now)}
    try:
        row = runtime.call(lambda: runtime.store.cas_update(expected_rev, payload))
    except MaintenanceUnavailable:
        return _unavailable()
    if row is None:
        try:
            current = runtime.read_fresh()
        except MaintenanceUnavailable:
            return _unavailable()
        return _wrong_step(current)
    new_state = normalize_state(row)
    runtime.apply_state(new_state)
    _write_log(runtime, actor, action, state["phase"], new_state["phase"], detail or {})
    return new_state


def _instance_summary(runtime: MaintenanceRuntime, instances: list[dict], now: datetime) -> list[dict]:
    out = []
    for row in instances:
        heartbeat = parse_ts(row.get("heartbeat_at"))
        age = None if heartbeat is None else int((now - heartbeat).total_seconds())
        if age is not None and age > 24 * 3600:
            continue  # long gone (an old deploy or restart)
        mine = row.get("instance_id") == runtime.instance_id
        out.append(
            {
                "instance": (row.get("instance_id") or "")[-12:],
                "this_one": mine,
                "in_flight": runtime.in_flight if mine else int(row.get("in_flight") or 0),
                "heartbeat_age_seconds": 0 if mine else age,
                "phase_seen": runtime.state["phase"] if mine else row.get("phase_seen"),
                "code_version": (row.get("code_version") or "")[:12],
            }
        )
    if not any(item["this_one"] for item in out):
        out.append(
            {
                "instance": runtime.instance_id[-12:],
                "this_one": True,
                "in_flight": runtime.in_flight,
                "heartbeat_age_seconds": 0,
                "phase_seen": runtime.state["phase"],
                "code_version": runtime.code_version[:12],
            }
        )
    return out


def _job_summary(jobs: list[dict], now: datetime) -> dict:
    running, stale, by_kind = 0, 0, {}
    for row in jobs:
        end = parse_ts(row.get("expected_end_at"))
        if end is not None and end > now:
            running += 1
            kind = str(row.get("kind") or "other")
            by_kind[kind] = by_kind.get(kind, 0) + 1
        else:
            stale += 1
    return {"running": running, "stale": stale, "by_kind": by_kind}


def safety_reasons(runtime: MaintenanceRuntime, state: dict, instances: list[dict], jobs: list[dict], now: datetime, body: Optional[ActivateBody]) -> list[dict]:
    """Why entering maintenance isn't safe yet (empty list = safe). Section C.5."""
    reasons: list[dict] = []
    drain_started = parse_ts(state.get("drain_started_at"))
    grace_ends = parse_ts(state.get("grace_ends_at"))
    wait_until = max(
        grace_ends or now,
        (drain_started + timedelta(seconds=DRAIN_SETTLE_SECONDS)) if drain_started else now,
    )
    if now < wait_until:
        reasons.append({"code": "grace_not_over", "seconds_left": math.ceil((wait_until - now).total_seconds())})
    running = _job_summary(jobs, now)["running"]
    if running:
        reasons.append({"code": "jobs_running", "count": running})
    in_flight = runtime.in_flight  # this instance: live count (admin routes aren't counted)
    silent = 0
    for row in instances:
        if row.get("instance_id") == runtime.instance_id:
            continue
        heartbeat = parse_ts(row.get("heartbeat_at"))
        count = int(row.get("in_flight") or 0)
        if heartbeat is None:
            continue
        age = (now - heartbeat).total_seconds()
        if age <= HEARTBEAT_FRESH_SECONDS:
            in_flight += count
        elif count > 0 and age <= HEARTBEAT_SILENT_LIMIT_SECONDS:
            silent += 1
    if in_flight:
        reasons.append({"code": "requests_in_flight", "count": in_flight})
    if silent:
        reasons.append({"code": "instance_silent", "count": silent})
    if state.get("reason") == "database_update":
        ref = (body.backup_ref or "").strip() if body else ""
        if not (body and body.backup_checked and BACKUP_REF_RE.match(ref)):
            reasons.append({"code": "backup_missing"})
    return reasons


def _admin_view(runtime: MaintenanceRuntime, state: dict) -> dict:
    now = runtime.clock()
    try:
        instances = runtime.call(runtime.store.list_instances)
        jobs = runtime.call(runtime.store.list_jobs)
        log = runtime.call(lambda: runtime.store.list_log(20))
    except MaintenanceUnavailable:
        instances, jobs, log = [], [], []
        partial = True
    else:
        partial = False
    view = {
        "status": public_status(state, now),
        "state": {
            "phase": state["phase"],
            "rev": int(state.get("rev") or 0),
            "reason": state.get("reason") or "",
            "note": state.get("note") or "",
            "start_at": iso(parse_ts(state.get("start_at"))),
            "estimated_end_at": iso(parse_ts(state.get("estimated_end_at"))),
            "drain_started_at": iso(parse_ts(state.get("drain_started_at"))),
            "grace_ends_at": iso(parse_ts(state.get("grace_ends_at"))),
            "activated_at": iso(parse_ts(state.get("activated_at"))),
            "backup_ref": state.get("backup_ref"),
            "counts_at_activation": state.get("counts_at_activation"),
            "checks": state.get("checks"),
            "checks_passed_at": iso(parse_ts(state.get("checks_passed_at"))),
            "reopened_at": iso(parse_ts(state.get("reopened_at"))),
        },
        "instances": _instance_summary(runtime, instances, now),
        "jobs": _job_summary(jobs, now),
        "log": [
            {
                "at": iso(parse_ts(row.get("at"))),
                "action": row.get("action"),
                "from_phase": row.get("from_phase"),
                "to_phase": row.get("to_phase"),
                "detail": row.get("detail") or {},
            }
            for row in log
        ],
        "partial": partial,
        "server_time": iso(now),
    }
    if state["phase"] == "draining":
        view["safety"] = safety_reasons(runtime, state, instances, jobs, now, None)
    return view


def _load(runtime: MaintenanceRuntime, body: RevBody):
    try:
        state = runtime.read_fresh()
    except MaintenanceUnavailable:
        return None, _unavailable()
    if int(state.get("rev") or 0) != body.expected_rev:
        return None, _wrong_step(state)
    return state, None


def _result(runtime: MaintenanceRuntime, outcome):
    if isinstance(outcome, JSONResponse):
        return outcome
    return _admin_view(runtime, outcome)


@admin_maintenance_router.get("")
def admin_get(_admin: str = Depends(require_admin)):
    runtime = get_runtime()
    try:
        state = runtime.read_fresh()
    except MaintenanceUnavailable:
        return _unavailable()
    return _admin_view(runtime, state)


@admin_maintenance_router.post("/schedule")
def admin_schedule(body: ScheduleBody, admin: str = Depends(require_admin)):
    runtime = get_runtime()
    state, refused = _load(runtime, body)
    if refused:
        return refused
    if state["phase"] not in ("none", "announced"):
        return _wrong_step(state)
    try:
        start, end = _times(body.start_local, body.estimated_end_local, runtime.clock())
    except TimeChoiceError as exc:
        return _refuse(422, exc.code, exc.message)
    changes = {
        **BREAK_FIELDS,
        "phase": "announced",
        "reason": body.reason,
        "note": body.note.strip(),
        "start_at": iso(start),
        "estimated_end_at": iso(end),
        "reopened_at": None,
    }
    action = "schedule" if state["phase"] == "none" else "change"
    return _result(runtime, _transition(runtime, admin, state, body.expected_rev, action, changes, {"reason": body.reason}))


@admin_maintenance_router.post("/postpone")
def admin_postpone(body: PostponeBody, admin: str = Depends(require_admin)):
    runtime = get_runtime()
    state, refused = _load(runtime, body)
    if refused:
        return refused
    if state["phase"] not in ("announced", "draining"):
        return _wrong_step(state)
    try:
        start, end = _times(body.start_local, body.estimated_end_local, runtime.clock())
    except TimeChoiceError as exc:
        return _refuse(422, exc.code, exc.message)
    changes = {**BREAK_FIELDS, "phase": "announced", "start_at": iso(start), "estimated_end_at": iso(end)}
    return _result(runtime, _transition(runtime, admin, state, body.expected_rev, "postpone", changes))


@admin_maintenance_router.post("/cancel")
def admin_cancel(body: RevBody, admin: str = Depends(require_admin)):
    runtime = get_runtime()
    state, refused = _load(runtime, body)
    if refused:
        return refused
    if state["phase"] not in ("announced", "draining"):
        return _wrong_step(state)
    changes = {**BREAK_FIELDS, "phase": "none", "reason": "", "note": ""}
    return _result(runtime, _transition(runtime, admin, state, body.expected_rev, "cancel", changes))


@admin_maintenance_router.post("/drain")
def admin_drain(body: DrainBody, admin: str = Depends(require_admin)):
    runtime = get_runtime()
    state, refused = _load(runtime, body)
    if refused:
        return refused
    if state["phase"] != "announced":
        return _wrong_step(state)
    now = runtime.clock()
    changes = {
        "phase": "draining",
        "drain_started_at": iso(now),
        "grace_ends_at": iso(now + timedelta(minutes=body.grace_minutes)),
    }
    return _result(
        runtime,
        _transition(runtime, admin, state, body.expected_rev, "drain", changes, {"grace_minutes": body.grace_minutes}),
    )


@admin_maintenance_router.post("/activate")
def admin_activate(body: ActivateBody, admin: str = Depends(require_admin)):
    runtime = get_runtime()
    state, refused = _load(runtime, body)
    if refused:
        return refused
    if state["phase"] != "draining":
        return _wrong_step(state)
    now = runtime.clock()
    try:
        instances = runtime.call(runtime.store.list_instances)
        jobs = runtime.call(runtime.store.list_jobs)
    except MaintenanceUnavailable:
        return _unavailable()
    reasons = safety_reasons(runtime, state, instances, jobs, now, body)
    counts: dict[str, int] = {}
    if not reasons:
        try:
            for table in COUNT_TABLES:
                counts[table] = runtime.call(lambda t=table: runtime.store.count_rows(t))
        except MaintenanceUnavailable:
            reasons.append({"code": "database_unreachable"})
    if reasons:
        _write_log(runtime, admin, "activate_refused", "draining", "draining", {"reasons": [r["code"] for r in reasons]})
        return _refuse(409, "maintenance_not_safe", NOT_SAFE_MESSAGE, reasons=reasons)
    ref = (body.backup_ref or "").strip()
    changes = {
        "phase": "active",
        "activated_at": iso(now),
        "counts_at_activation": counts,
        "backup_ref": ref if BACKUP_REF_RE.match(ref) else None,
        "checks": None,
        "checks_passed_at": None,
    }
    return _result(runtime, _transition(runtime, admin, state, body.expected_rev, "activate", changes, {"counts": counts}))


def run_checks(runtime: MaintenanceRuntime, state: dict, counts_drop_reason: Optional[str]) -> list[dict]:
    """Section C.6. Names, codes and counts only."""
    results: list[dict] = []

    failed_tables = []
    for table in CORE_TABLES:
        try:
            runtime.call(lambda t=table: runtime.store.probe(t, ("id",) if t != "profiles" else ("user_id",)))
        except MaintenanceUnavailable:
            failed_tables.append(table)
    results.append({"name": "database", "passed": not failed_tables, "detail": {"failed_tables": failed_tables}})

    missing = []
    for table, columns in REQUIRED_SCHEMA.items():
        try:
            runtime.call(lambda t=table, c=columns: runtime.store.probe(t, c))
        except MaintenanceUnavailable:
            missing.append(table)
    results.append({"name": "schema", "passed": not missing, "detail": {"failed_tables": missing}})

    before = state.get("counts_at_activation") or {}
    dropped: dict[str, dict] = {}
    unreadable = []
    for table in COUNT_TABLES:
        try:
            now_count = runtime.call(lambda t=table: runtime.store.count_rows(t))
        except MaintenanceUnavailable:
            unreadable.append(table)
            continue
        was = before.get(table) if isinstance(before, dict) else None
        if isinstance(was, int) and now_count < was:
            dropped[table] = {"before": was, "now": now_count}
    explained = bool(state.get("reason") == "other" and (counts_drop_reason or "").strip())
    kept = not unreadable and (not dropped or explained) and isinstance(before, dict) and bool(before)
    results.append(
        {
            "name": "records_kept",
            "passed": kept,
            "detail": {"dropped": dropped, "unreadable": unreadable, "explained": explained and bool(dropped)},
        }
    )

    log_ok = True
    try:
        row = {
            "at": iso(runtime.clock()),
            "actor_user_id": None,
            "action": "log_check",
            "from_phase": state["phase"],
            "to_phase": state["phase"],
            "detail": {},
        }
        runtime.call(lambda: runtime.store.insert_log(row))
    except MaintenanceUnavailable:
        log_ok = False
    results.append({"name": "log_write", "passed": log_ok, "detail": {}})

    try:
        names = runtime.call(runtime.store.list_bucket_names)
        storage_ok, bucket_count = True, len(names)
    except MaintenanceUnavailable:
        storage_ok, bucket_count = False, 0
    results.append({"name": "storage", "passed": storage_ok, "detail": {"buckets": bucket_count}})

    results.append(_code_version_check(runtime))
    return results


def _code_version_check(runtime: MaintenanceRuntime) -> dict:
    """Every server that reported in the last two minutes runs the same code as this one.
    Two different versions mean a deploy is still rolling out (or half failed): don't reopen."""
    now = runtime.clock()
    try:
        instances = runtime.call(runtime.store.list_instances)
    except MaintenanceUnavailable:
        return {"name": "code_version", "passed": False, "detail": {"version": runtime.code_version[:12], "versions_seen": 0}}
    versions = {runtime.code_version} if runtime.code_version else set()
    for row in instances:
        heartbeat = parse_ts(row.get("heartbeat_at"))
        if heartbeat is None or (now - heartbeat).total_seconds() > HEARTBEAT_FRESH_SECONDS:
            continue
        if row.get("code_version"):
            versions.add(str(row["code_version"]))
    return {
        "name": "code_version",
        "passed": len(versions) <= 1,
        "detail": {"version": runtime.code_version[:12], "versions_seen": len(versions)},
    }


@admin_maintenance_router.post("/checks")
def admin_checks(body: ChecksBody, admin: str = Depends(require_admin)):
    runtime = get_runtime()
    state, refused = _load(runtime, body)
    if refused:
        return refused
    if state["phase"] not in ("active", "checking"):
        return _wrong_step(state)
    results = run_checks(runtime, state, body.counts_drop_reason)
    now = runtime.clock()
    passed = all(item["passed"] for item in results)
    changes = {
        "phase": "checking",
        "checks": {"ran_at": iso(now), "results": results},
        "checks_passed_at": iso(now) if passed else None,
    }
    detail = {"failed": [item["name"] for item in results if not item["passed"]]}
    return _result(runtime, _transition(runtime, admin, state, body.expected_rev, "checks", changes, detail))


@admin_maintenance_router.post("/reopen")
def admin_reopen(body: RevBody, admin: str = Depends(require_admin)):
    runtime = get_runtime()
    state, refused = _load(runtime, body)
    if refused:
        return refused
    if state["phase"] != "checking":
        return _wrong_step(state)
    checks = state.get("checks") or {}
    results = checks.get("results") if isinstance(checks, dict) else None
    passed_at = parse_ts(state.get("checks_passed_at"))
    now = runtime.clock()
    if not results or not all(item.get("passed") for item in results) or passed_at is None:
        return _refuse(409, "checks_not_passed", "Every check has to pass before Luma can reopen.")
    if (now - passed_at).total_seconds() > REOPEN_CHECKS_VALID_SECONDS:
        return _refuse(409, "checks_too_old", "The checks are more than 30 minutes old. Run them again.")
    changes = {**BREAK_FIELDS, "phase": "none", "reopened_at": iso(now)}
    return _result(runtime, _transition(runtime, admin, state, body.expected_rev, "reopen", changes))
