"""Monthly student feedback poll: "If it ain't broke why fix it?!".

Students (signed in) see the open poll, answer it once (email must be verified),
can skip it, and see results as PERCENTAGES ONLY after it closes (last 24 closed
polls). Admins (users.role = 'admin') draft, schedule and approve polls, watch
live totals (counts and percentages), read comment TEXT (never who wrote it),
group comments into themes locally, flag urgent issues and write status updates.

Rules this module keeps:
- Status comes from the clock (feedback_schedule.poll_status); nothing opens or
  closes by hand, and only an admin-approved poll ever opens.
- One ballot per account AND per email per poll, enforced by the database
  (feedback_submit + unique keys). A retry is acknowledged, never re-counted.
- No rewards: voting touches only feedback_* tables.
- No outside services: comments never leave Luma (no AI, no analytics).
- Logs hold categories and counts only: never ids, emails, answers or text.

Storage: schemas/migrations/2026_11_18_monthly_feedback.sql (NOT APPLIED yet).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Literal, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import feedback_math, feedback_schedule, feedback_text, feedback_themes
from .ai_allowance import normalize_email
from .auth import get_current_user_id, get_jwt_secret_key, require_admin, require_verified_user
from .rate_limits import SlidingWindowLimiter
from .supabase_client import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

UTC = timezone.utc
POLLS = "feedback_polls"
QUESTIONS = "feedback_questions"
RESPONSES = "feedback_responses"
ANSWERS = "feedback_answers"
SKIPS = "feedback_skips"
THEMES = "feedback_comment_themes"
MEMBERS = "feedback_theme_members"
UPDATES = "feedback_admin_updates"

PAGE = 1000
STUDENT_ARCHIVE_LIMIT = 24
# Students see a question's Yes % and No % only once this many students answered it,
# so a result like 100/0 from one or two people can't give away how someone voted.
STUDENT_MIN_ANSWERS = 5
LATEST_RESULTS_DAYS = 14
MAX_QUESTIONS = 12
UPDATE_STATUSES = ("reviewing", "planned", "keeping", "done")

VOTES_PER_USER_PER_HOUR = 20
ADMIN_WRITES_PER_HOUR = 300
REGROUPS_PER_HOUR = 30
vote_limiter = SlidingWindowLimiter(VOTES_PER_USER_PER_HOUR, 60 * 60)
admin_write_limiter = SlidingWindowLimiter(ADMIN_WRITES_PER_HOUR, 60 * 60)
regroup_limiter = SlidingWindowLimiter(REGROUPS_PER_HOUR, 60 * 60)
LIMITERS = (vote_limiter, admin_write_limiter, regroup_limiter)

MSG_RECEIVED = "Thanks! We got your answers."
MSG_ALREADY = "We already have your answers for this poll. Thanks!"
MSG_SKIPPED = "Okay! We skipped this poll for you."
MSG_NOT_FOUND = "We couldn't find that poll."
MSG_NOT_OPEN = "This poll isn't open yet."
MSG_CLOSED = "This poll closed before your answers arrived."
MSG_EMPTY = "Answer at least one question, or skip the poll."
MSG_TOO_LONG = f"Please shorten your comment to {feedback_text.COMMENT_MAX} characters or fewer."
MSG_UNKNOWN_QUESTION = "One of those questions isn't in this poll. Reload the page and try again."
MSG_BAD_ANSWERS = "Something was wrong with those answers. Reload the page and try again."
MSG_RESULTS_NOT_READY = "Results come out when the poll closes."
MSG_TRY_AGAIN = "Something went wrong. Your answers are still here. Try again."
MSG_UNAVAILABLE = "The monthly poll isn't available right now."
MSG_RATE_LIMITED = "That's a lot of tries. Wait a bit and try again."
MSG_WORDING_APPROVED = "Move it back to draft to edit questions."
MSG_WORDING_STARTED = "Voting has started, so the wording is locked."
MSG_OPENS_IN_PAST = "The opening time has already passed. Pick a later time."
MSG_OVERLAP = "Another scheduled poll is already open at that time."
MSG_NO_QUESTIONS = "Add at least one question first."
MSG_CHECKLIST = "Check both boxes to approve."
MSG_BAD_WINDOW = "The poll must close after it opens, and stay open 31 days or less."
MSG_AFTER_CLOSE = "Totals and comments show up after the poll closes, so no one can tell who wrote what."
UPDATE_SUMMARY_DEFAULT = "We're reviewing your feedback."
MISSING_CODES = {"PGRST205", "PGRST202", "42P01", "42883"}


def _clock() -> datetime:
    return datetime.now(UTC)


class Unavailable(Exception):
    """The feedback tables or functions are not installed (migration not applied)."""


# ---------------------------------------------------------------- small helpers


def _error(status: int, code: str, detail: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": detail, "error_code": code, **extra})


def _rows(response: Any) -> list:
    data = getattr(response, "data", None) if response is not None else None
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    return []


def _pg(exc: Exception) -> tuple[str, str]:
    code = getattr(exc, "code", None)
    message = getattr(exc, "message", None) or str(exc)
    return str(code or ""), str(message or "")


def _is_missing(exc: Exception) -> bool:
    code, message = _pg(exc)
    return code in MISSING_CODES or "Could not find the" in message


def _run(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        if _is_missing(exc):
            raise Unavailable() from exc
        raise


def _select_all(make: Callable[[], Any]) -> list:
    """Every row of a query, 1000 at a time (PostgREST caps a single read)."""
    out: list = []
    start = 0
    while True:
        page = _rows(_run(lambda: make().range(start, start + PAGE - 1).execute()))
        out.extend(page)
        if len(page) < PAGE:
            return out
        start += PAGE


def _ts(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


def _month(value: Any) -> str:
    return str(value)[:10]


def _uuid_or_none(value: Any) -> Optional[str]:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        return None


VOTER_KEY_SECRET_ENV = "FEEDBACK_VOTER_KEY_SECRET"


def _voter_key_secret() -> str:
    """FEEDBACK_VOTER_KEY_SECRET, or the JWT secret when it isn't set.

    Changing this secret while a poll is open changes every voter_key, so a deleted
    account's email no longer matches its ballot: a re-made account could vote again
    in THAT poll. Rotate it between polls.
    """
    return os.environ.get(VOTER_KEY_SECRET_ENV, "").strip() or get_jwt_secret_key() or ""


def voter_key(email: Any) -> Optional[str]:
    """Keyed one-way hash of the normalized email (never the email itself)."""
    normalized = normalize_email(email)
    secret = _voter_key_secret()
    if normalized is None or not secret:
        return None
    message = b"luma-feedback-voter:" + normalized.encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


# A deleted account's ballot keeps its voter_key only while that poll is open (to stop a
# re-made account voting twice). After the poll closes the key is cleared, so nobody holding
# the secret can match a known email to those answers. Run lazily and at most this often.
FORGET_KEYS_EVERY = timedelta(minutes=15)
_forget_lock = threading.Lock()
_forget_state: dict[str, Optional[datetime]] = {"last": None}


def forget_closed_voter_keys(now: datetime, force: bool = False) -> int:
    """Clear voter_key on anonymous ballots of closed polls. Never raises."""
    with _forget_lock:
        last = _forget_state["last"]
        if not force and last is not None and timedelta(0) <= now - last < FORGET_KEYS_EVERY:
            return 0
        _forget_state["last"] = now
    try:
        response = _run(lambda: get_supabase().rpc("feedback_forget_voter_keys", {}).execute())
    except Unavailable:
        return 0
    except Exception as exc:  # noqa: BLE001
        logger.warning("Feedback voter key cleanup failed (%s)", type(exc).__name__)
        return 0
    data = getattr(response, "data", None) if response is not None else None
    count = data if isinstance(data, int) and not isinstance(data, bool) else 0
    if count:
        logger.info("Feedback voter keys cleared count=%d", count)
    return count


# ---------------------------------------------------------------- polls


def _poll(row: dict, now: datetime) -> dict:
    poll = {
        "id": str(row["id"]),
        "period_month": _month(row.get("period_month")),
        "opens_at": _ts(row.get("opens_at")),
        "closes_at": _ts(row.get("closes_at")),
        "approved_at": _ts(row.get("approved_at")),
    }
    poll["status"] = feedback_schedule.poll_status(
        feedback_schedule.PollTimes(poll["opens_at"], poll["closes_at"], poll["approved_at"]), now
    )
    return poll


def _load_polls(now: datetime) -> list[dict]:
    db = get_supabase()
    rows = _select_all(
        lambda: db.table(POLLS).select("id, period_month, opens_at, closes_at, approved_at").order("period_month", desc=True)
    )
    polls = [_poll(row, now) for row in rows]
    polls.sort(key=lambda p: p["period_month"], reverse=True)
    return polls


def _load_poll(poll_id: str, now: datetime) -> Optional[dict]:
    if _uuid_or_none(poll_id) is None:
        return None
    rows = _rows(
        _run(
            lambda: get_supabase()
            .table(POLLS)
            .select("id, period_month, opens_at, closes_at, approved_at")
            .eq("id", poll_id)
            .limit(1)
            .execute()
        )
    )
    return _poll(rows[0], now) if rows else None


def _questions(poll_id: str) -> list[dict]:
    db = get_supabase()
    rows = _select_all(lambda: db.table(QUESTIONS).select("id, position, label").eq("poll_id", poll_id).order("position"))
    rows = [{"id": str(r["id"]), "position": int(r["position"]), "label": r["label"]} for r in rows]
    rows.sort(key=lambda r: r["position"])
    return rows


def _closed_for_students(polls: list[dict]) -> list[dict]:
    closed = [p for p in polls if p["status"] == "closed"]
    closed.sort(key=lambda p: p["closes_at"], reverse=True)
    return closed[:STUDENT_ARCHIVE_LIMIT]


def _totals(poll_id: str) -> tuple[int, list[dict]]:
    rows = _rows(_run(lambda: get_supabase().rpc("feedback_totals", {"p_poll_id": poll_id}).execute()))
    return feedback_math.build_results(rows)


def _participants(poll_id: str) -> int:
    participants, _ = _totals(poll_id)
    return participants


def _user(user_id: str) -> dict:
    try:
        response = get_supabase().table("users").select("email, email_verified").eq("id", user_id).maybe_single().execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Feedback user read failed (%s)", type(exc).__name__)
        return {}
    data = getattr(response, "data", None) if response is not None else None
    return data if isinstance(data, dict) else {}


def _find_ballot(poll_id: str, user_id: str, key: Optional[str]) -> Optional[dict]:
    """The caller's ballot: by account, or by email key (a deleted-and-recreated account)."""
    db = get_supabase()
    rows = _rows(
        _run(
            lambda: db.table(RESPONSES).select("id, submitted_at, comment").eq("poll_id", poll_id).eq("user_id", user_id).limit(1).execute()
        )
    )
    if rows:
        return {**rows[0], "own": True}
    if key:
        rows = _rows(
            _run(lambda: db.table(RESPONSES).select("id, submitted_at").eq("poll_id", poll_id).eq("voter_key", key).limit(1).execute())
        )
        if rows:
            return {**rows[0], "own": False}
    return None


# ---------------------------------------------------------------- student models


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class QuestionOut(StrictModel):
    id: str
    position: int
    label: str


class OpenPollOut(StrictModel):
    id: str
    title: str
    intro: str
    privacy_note: str
    comment_label: str
    comment_hint: str
    comment_max: int
    opens_at: str
    closes_at: str
    status: Literal["open"]
    questions: list[QuestionOut]


class MyAnswerOut(StrictModel):
    question_id: str
    choice: Literal["yes", "no"]


class MyResponseOut(StrictModel):
    submitted_at: Optional[str]
    answers: list[MyAnswerOut]
    comment: Optional[str]


class LatestResultsOut(StrictModel):
    poll_id: str
    closed_at: str


class CurrentOut(StrictModel):
    server_now: str
    schedule_tz: str
    poll: Optional[OpenPollOut]
    my_response: Optional[MyResponseOut]
    skipped: bool
    can_vote: bool
    blocked_reason: Optional[Literal["email_unverified"]]
    next_opens_at: Optional[str]
    latest_results: Optional[LatestResultsOut]


class AnswerIn(StrictModel):
    question_id: uuid.UUID
    choice: Literal["yes", "no"]


class BallotIn(StrictModel):
    answers: list[AnswerIn] = Field(default_factory=list, max_length=MAX_QUESTIONS)
    comment: Optional[str] = Field(default=None, max_length=5000)


class BallotOut(StrictModel):
    status: Literal["received", "already_received"]
    message: str
    submitted_at: Optional[str]


class SkipOut(StrictModel):
    status: Literal["skipped", "already_received"]
    message: str


class ArchiveItemOut(StrictModel):
    id: str
    title: str
    period_month: str
    opens_at: str
    closes_at: str


class PublicQuestionOut(StrictModel):
    id: str
    position: int
    label: str
    yes_pct: Optional[int]
    no_pct: Optional[int]


class PublicUpdateOut(StrictModel):
    title: str
    status: Literal["reviewing", "planned", "keeping", "done"]
    note: Optional[str]


class PublicResultsOut(StrictModel):
    poll: ArchiveItemOut
    questions: list[PublicQuestionOut]
    updates: list[PublicUpdateOut]
    update_summary: Optional[str]


# ---------------------------------------------------------------- student routes


def _empty_current(now: datetime) -> dict:
    return {
        "server_now": _iso(now),
        "schedule_tz": feedback_schedule.SCHEDULE_TZ_NAME,
        "poll": None,
        "my_response": None,
        "skipped": False,
        "can_vote": False,
        "blocked_reason": None,
        "next_opens_at": None,
        "latest_results": None,
    }


def _my_response(ballot: dict) -> dict:
    if not ballot.get("own"):
        # A ballot from an earlier, deleted account with the same email: it stays
        # anonymous, so only "already answered" is shown.
        return {"submitted_at": _iso(_ts(ballot.get("submitted_at"))), "answers": [], "comment": None}
    db = get_supabase()
    rows = _select_all(lambda: db.table(ANSWERS).select("question_id, wants_change").eq("response_id", ballot["id"]))
    answers = [
        {"question_id": str(r["question_id"]), "choice": "yes" if r.get("wants_change") else "no"} for r in rows
    ]
    return {"submitted_at": _iso(_ts(ballot.get("submitted_at"))), "answers": answers, "comment": ballot.get("comment")}


def _has_skipped(poll_id: str, user_id: str) -> bool:
    try:
        rows = _rows(
            _run(lambda: get_supabase().table(SKIPS).select("poll_id").eq("poll_id", poll_id).eq("user_id", user_id).limit(1).execute())
        )
    except Unavailable:
        return False
    return bool(rows)


@router.get("/feedback/current", response_model=CurrentOut)
def feedback_current(user_id: str = Depends(get_current_user_id)):
    now = _clock()
    out = _empty_current(now)
    forget_closed_voter_keys(now)
    try:
        polls = _load_polls(now)
        upcoming = sorted((p for p in polls if p["status"] == "scheduled"), key=lambda p: p["opens_at"])
        out["next_opens_at"] = _iso(upcoming[0]["opens_at"]) if upcoming else None
        recent = [p for p in _closed_for_students(polls) if p["closes_at"] >= now - timedelta(days=LATEST_RESULTS_DAYS)]
        if recent:
            out["latest_results"] = {"poll_id": recent[0]["id"], "closed_at": _iso(recent[0]["closes_at"])}
        open_polls = [p for p in polls if p["status"] == "open"]
        if not open_polls:
            return out
        poll = open_polls[0]
        out["poll"] = {
            "id": poll["id"],
            "title": feedback_text.EVENT_TITLE,
            "intro": feedback_text.EVENT_INTRO,
            "privacy_note": feedback_text.PRIVACY_NOTE,
            "comment_label": feedback_text.COMMENT_LABEL,
            "comment_hint": feedback_text.COMMENT_HINT,
            "comment_max": feedback_text.COMMENT_MAX,
            "opens_at": _iso(poll["opens_at"]),
            "closes_at": _iso(poll["closes_at"]),
            "status": "open",
            "questions": _questions(poll["id"]),
        }
        user = _user(user_id)
        verified = user.get("email_verified") is True
        # The email key is only checked for a verified email: an unverified sign-up with
        # someone else's address must not learn whether (or when) that address voted.
        ballot = _find_ballot(poll["id"], user_id, voter_key(user.get("email")) if verified else None)
        out["my_response"] = _my_response(ballot) if ballot else None
        out["skipped"] = _has_skipped(poll["id"], user_id)
        out["can_vote"] = ballot is None and verified
        out["blocked_reason"] = "email_unverified" if ballot is None and not verified else None
    except Unavailable:
        return _empty_current(now)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Feedback current read failed (%s)", type(exc).__name__)
        return _error(503, "try_again", MSG_UNAVAILABLE)
    return out


def _ballot_done(ballot: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"status": "already_received", "message": MSG_ALREADY, "submitted_at": _iso(_ts(ballot.get("submitted_at")))},
    )


@router.post(
    "/feedback/polls/{poll_id}/responses",
    response_model=BallotOut,
    status_code=201,
    responses={200: {"model": BallotOut, "description": "Already received (retry or second send)"}},
)
def feedback_submit(poll_id: str, payload: BallotIn, user_id: str = Depends(require_verified_user)):
    if not vote_limiter.hit(user_id):
        return _error(429, "rate_limited", MSG_RATE_LIMITED)
    now = _clock()
    try:
        poll = _load_poll(poll_id, now)
        if poll is None or poll["approved_at"] is None:
            return _error(404, "poll_not_found", MSG_NOT_FOUND)
        poll_id = poll["id"]
        key = voter_key(_user(user_id).get("email"))
        if key is None:
            return _error(403, "email_unverified", "Verify your email to answer the poll.")
        existing = _find_ballot(poll_id, user_id, key)
        if existing:
            return _ballot_done(existing)
        if poll["status"] == "scheduled":
            return _error(409, "poll_not_open", MSG_NOT_OPEN)
        if poll["status"] == "closed":
            return _error(409, "poll_closed", MSG_CLOSED, closes_at=_iso(poll["closes_at"]))
        question_ids = {q["id"] for q in _questions(poll_id)}
    except Unavailable:
        return _error(503, "feedback_unavailable", MSG_UNAVAILABLE)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Feedback ballot pre-check failed (%s)", type(exc).__name__)
        return _error(503, "try_again", MSG_TRY_AGAIN)

    answers = [(str(a.question_id), a.choice) for a in payload.answers]
    if len({qid for qid, _ in answers}) != len(answers):
        return _error(422, "bad_answers", MSG_BAD_ANSWERS)
    if any(qid not in question_ids for qid, _ in answers):
        return _error(422, "unknown_question", MSG_UNKNOWN_QUESTION)
    try:
        comment = feedback_text.clean_comment(payload.comment)
    except feedback_text.CommentTooLong:
        return _error(422, "comment_too_long", MSG_TOO_LONG)
    if not answers and comment is None:
        return _error(422, "empty_response", MSG_EMPTY)
    flags = feedback_text.urgent_flags(comment)

    params = {
        "p_poll_id": poll_id,
        "p_user_id": user_id,
        "p_voter_key": key,
        "p_answers": [{"question_id": qid, "wants_change": choice == "yes"} for qid, choice in answers],
        "p_comment": comment,
        "p_urgent_flags": flags,
    }
    try:
        rows = _rows(_run(lambda: get_supabase().rpc("feedback_submit", params).execute()))
    except Unavailable:
        return _error(503, "feedback_unavailable", MSG_UNAVAILABLE)
    except Exception as exc:  # noqa: BLE001
        code, message = _pg(exc)
        if "poll_closed" in message:
            return _error(409, "poll_closed", MSG_CLOSED, closes_at=_iso(poll["closes_at"]))
        if "poll_not_open" in message:
            return _error(409, "poll_not_open", MSG_NOT_OPEN)
        if "email_unverified" in message:
            return _error(403, "email_unverified", "Verify your email to answer the poll.")
        if code == "23505":
            again = _find_ballot(poll_id, user_id, key)
            if again:
                return _ballot_done(again)
        if code in ("23503", "23514", "22P02"):
            return _error(422, "bad_answers", MSG_BAD_ANSWERS)
        logger.warning("Feedback ballot failed (%s %s)", type(exc).__name__, code)
        return _error(503, "try_again", MSG_TRY_AGAIN)
    if not rows:
        logger.warning("Feedback ballot returned nothing")
        return _error(503, "try_again", MSG_TRY_AGAIN)
    row = rows[0]
    created = row.get("created") is True
    logger.info("Feedback ballot created=%s answers=%d has_comment=%s flags=%d", created, len(answers), comment is not None, len(flags))
    if not created:
        return _ballot_done({"submitted_at": row.get("received_at")})
    return JSONResponse(
        status_code=201,
        content={"status": "received", "message": MSG_RECEIVED, "submitted_at": _iso(_ts(row.get("received_at")))},
    )


@router.post("/feedback/polls/{poll_id}/skip", response_model=SkipOut)
def feedback_skip(poll_id: str, user_id: str = Depends(get_current_user_id)):
    """Skip the whole poll in one tap. Not a vote: it only stops the Home reminder."""
    if not vote_limiter.hit(user_id):
        return _error(429, "rate_limited", MSG_RATE_LIMITED)
    now = _clock()
    try:
        poll = _load_poll(poll_id, now)
        if poll is None or poll["approved_at"] is None:
            return _error(404, "poll_not_found", MSG_NOT_FOUND)
        if poll["status"] == "scheduled":
            return _error(409, "poll_not_open", MSG_NOT_OPEN)
        if poll["status"] == "closed":
            return _error(409, "poll_closed", "This poll is already closed.")
        own = _rows(
            _run(lambda: get_supabase().table(RESPONSES).select("id").eq("poll_id", poll["id"]).eq("user_id", user_id).limit(1).execute())
        )
        if own:
            return {"status": "already_received", "message": MSG_ALREADY}
        if not _has_skipped(poll["id"], user_id):
            try:
                _run(lambda: get_supabase().table(SKIPS).insert({"poll_id": poll["id"], "user_id": user_id}).execute())
            except Unavailable:
                raise
            except Exception as exc:  # noqa: BLE001
                if _pg(exc)[0] != "23505":  # a double tap: already skipped
                    raise
    except Unavailable:
        return _error(503, "feedback_unavailable", MSG_UNAVAILABLE)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Feedback skip failed (%s)", type(exc).__name__)
        return _error(503, "try_again", MSG_TRY_AGAIN)
    logger.info("Feedback poll skipped")
    return {"status": "skipped", "message": MSG_SKIPPED}


def _archive_item(poll: dict) -> dict:
    return {
        "id": poll["id"],
        "title": feedback_text.EVENT_TITLE,
        "period_month": poll["period_month"],
        "opens_at": _iso(poll["opens_at"]),
        "closes_at": _iso(poll["closes_at"]),
    }


@router.get("/feedback/results", response_model=list[ArchiveItemOut])
def feedback_results_archive(_user_id: str = Depends(get_current_user_id)):
    try:
        polls = _load_polls(_clock())
    except Unavailable:
        return []
    return [_archive_item(p) for p in _closed_for_students(polls)]


def _published_updates(poll_id: str) -> list[dict]:
    db = get_supabase()
    try:
        rows = _select_all(lambda: db.table(UPDATES).select("title, status, note, position, published, created_at").eq("poll_id", poll_id).order("position"))
    except Unavailable:
        return []
    rows = [r for r in rows if r.get("published") is True]
    rows.sort(key=lambda r: (int(r.get("position") or 0), str(r.get("created_at") or "")))
    return [{"title": r["title"], "status": r["status"], "note": r.get("note")} for r in rows]


def _student_rows(questions: list[dict]) -> list[dict]:
    """Yes % and No % per question, hidden (null) below STUDENT_MIN_ANSWERS answers.

    Shown rows keep the most-wanted-first order; hidden rows go last in question
    order, so their place in the list gives nothing away either.
    """
    shown, hidden = [], []
    for q in questions:
        row = {"id": q["id"], "position": q["position"], "label": q["label"], "yes_pct": q["yes_pct"], "no_pct": q["no_pct"]}
        if q["answered"] < STUDENT_MIN_ANSWERS or q["yes_pct"] is None:
            row["yes_pct"] = row["no_pct"] = None
            hidden.append(row)
        else:
            shown.append(row)
    hidden.sort(key=lambda r: r["position"])
    return shown + hidden


@router.get("/feedback/results/{poll_id}", response_model=PublicResultsOut)
def feedback_results_detail(poll_id: str, _user_id: str = Depends(get_current_user_id)):
    now = _clock()
    try:
        poll = _load_poll(poll_id, now)
        if poll is None or poll["approved_at"] is None:
            return _error(404, "poll_not_found", MSG_NOT_FOUND)
        if poll["status"] in ("scheduled", "open"):
            return _error(409, "results_not_ready", MSG_RESULTS_NOT_READY, closes_at=_iso(poll["closes_at"]))
        if poll["id"] not in {p["id"] for p in _closed_for_students(_load_polls(now))}:
            return _error(404, "poll_not_found", MSG_NOT_FOUND)  # older than the last 24
        _participants_count, questions = _totals(poll["id"])
        questions = _student_rows(questions)
        updates = _published_updates(poll["id"])
    except Unavailable:
        return _error(404, "poll_not_found", MSG_NOT_FOUND)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Feedback results read failed (%s)", type(exc).__name__)
        return _error(503, "try_again", MSG_UNAVAILABLE)
    return {
        "poll": _archive_item(poll),
        # Percentages only for students: never counts, participants or comments.
        "questions": questions,
        "updates": updates,
        "update_summary": None if updates else UPDATE_SUMMARY_DEFAULT,
    }


# ---------------------------------------------------------------- admin helpers


def ensure_monthly_drafts(now: datetime) -> int:
    """Create drafts for this Chicago month and the next one. Never approves anything."""
    db = get_supabase()
    existing = {p["period_month"] for p in _load_polls(now)}
    created = 0
    month = feedback_schedule.chicago_month(now)
    for target in (month, feedback_schedule.next_month(month)):
        key = target.isoformat()
        if key in existing:
            continue
        opens, closes = feedback_schedule.default_window(target.year, target.month)
        try:
            _run(lambda: db.table(POLLS).insert({"period_month": key, "opens_at": _iso(opens), "closes_at": _iso(closes)}).execute())
            created += 1
        except Unavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            if _pg(exc)[0] != "23505":  # another admin tab made it first
                raise
    if created:
        logger.info("Feedback drafts created=%d", created)
    return created


def _admin_limited(admin_id: str) -> Optional[JSONResponse]:
    if not admin_write_limiter.hit(admin_id):
        return _error(429, "rate_limited", MSG_RATE_LIMITED)
    return None


def _admin_summary(poll: dict, question_count: int, participants: int) -> dict:
    return {
        "id": poll["id"],
        "period_month": poll["period_month"],
        "opens_at": _iso(poll["opens_at"]),
        "closes_at": _iso(poll["closes_at"]),
        "opens_local": feedback_schedule.utc_to_chicago_local(poll["opens_at"]),
        "closes_local": feedback_schedule.utc_to_chicago_local(poll["closes_at"]),
        "approved_at": _iso(poll["approved_at"]),
        "status": poll["status"],
        "question_count": question_count,
        "participants": participants,
    }


def _admin_detail(poll: dict) -> dict:
    questions = _questions(poll["id"])
    started = poll["status"] in ("open", "closed")
    participants = _participants(poll["id"]) if started else 0
    month = date.fromisoformat(poll["period_month"])
    d_open, d_close = feedback_schedule.default_window(month.year, month.month)
    return {
        **_admin_summary(poll, len(questions), participants),
        "title": feedback_text.EVENT_TITLE,
        "intro": feedback_text.EVENT_INTRO,
        "questions": questions,
        "can_edit_questions": poll["approved_at"] is None,
        "can_edit_dates": not started or poll["approved_at"] is None,
        "can_approve": poll["approved_at"] is None,
        "can_unapprove": poll["status"] == "scheduled",
        "lint": feedback_text.question_lint([q["label"] for q in questions]),
        "default_opens_local": feedback_schedule.utc_to_chicago_local(d_open),
        "default_closes_local": feedback_schedule.utc_to_chicago_local(d_close),
    }


def _overlaps(poll_id: str, opens: datetime, closes: datetime, now: datetime) -> bool:
    for other in _load_polls(now):
        if other["id"] == poll_id or other["approved_at"] is None:
            continue
        if opens < other["closes_at"] and other["opens_at"] < closes:
            return True
    return False


def _map_poll_write_error(exc: Exception) -> Optional[JSONResponse]:
    code, message = _pg(exc)
    if "wording_locked" in message:
        return _error(409, "wording_locked", MSG_WORDING_STARTED)
    if "opens_in_past" in message:
        return _error(409, "opens_in_past", MSG_OPENS_IN_PAST)
    if "no_questions" in message:
        return _error(422, "no_questions", MSG_NO_QUESTIONS)
    if code == "23P01":
        return _error(409, "overlap", MSG_OVERLAP)
    if code == "23514":
        return _error(422, "bad_window", MSG_BAD_WINDOW)
    return None


def _admin_guard(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Unavailable:
        return _error(503, "feedback_unavailable", MSG_UNAVAILABLE)
    except Exception as exc:  # noqa: BLE001
        mapped = _map_poll_write_error(exc)
        if mapped is not None:
            return mapped
        logger.warning("Feedback admin action failed (%s)", type(exc).__name__)
        return _error(503, "try_again", "Something went wrong. Try again.")


def _admin_poll_or_404(poll_id: str, now: datetime):
    poll = _load_poll(poll_id, now)
    if poll is None:
        return None, _error(404, "poll_not_found", MSG_NOT_FOUND)
    return poll, None


def _closed_poll_or_error(poll_id: str, now: datetime):
    """Comments, themes and flags exist for admins only once the poll has closed.

    While it is open, an admin could compare the comment list (or the totals) before
    and after a known student votes and so match that student to their answers.
    """
    poll, missing = _admin_poll_or_404(poll_id, now)
    if missing:
        return None, missing
    if poll["status"] != "closed":
        return None, _error(409, "after_close", MSG_AFTER_CLOSE, closes_at=_iso(poll["closes_at"]))
    return poll, None


# ---------------------------------------------------------------- admin models


class DatesIn(StrictModel):
    opens_local: str = Field(..., min_length=1, max_length=40)
    closes_local: str = Field(..., min_length=1, max_length=40)


class QuestionIn(StrictModel):
    label: str = Field(..., max_length=400)


class QuestionsIn(StrictModel):
    questions: list[QuestionIn] = Field(..., max_length=MAX_QUESTIONS * 2)


class ChecklistIn(StrictModel):
    one_change_each: bool = False
    yes_means_change: bool = False


class ApproveIn(StrictModel):
    checklist: ChecklistIn


class MergeIn(StrictModel):
    poll_id: uuid.UUID
    into_theme_id: uuid.UUID
    from_theme_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=50)


class SplitIn(StrictModel):
    label: str = Field(..., min_length=1, max_length=80)
    response_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=2000)


class RenameIn(StrictModel):
    label: str = Field(..., min_length=1, max_length=80)


class FlagsIn(StrictModel):
    urgent_flags: list[Literal["security", "accessibility", "privacy"]] = Field(..., max_length=3)


class UpdateCreate(StrictModel):
    title: str = Field(..., min_length=1, max_length=160)
    status: Literal["reviewing", "planned", "keeping", "done"] = "reviewing"
    note: Optional[str] = Field(default=None, max_length=600)
    position: Optional[int] = Field(default=None, ge=1, le=50)
    published: bool = False


class UpdatePatch(StrictModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=160)
    status: Optional[Literal["reviewing", "planned", "keeping", "done"]] = None
    note: Optional[str] = Field(default=None, max_length=600)
    position: Optional[int] = Field(default=None, ge=1, le=50)
    published: Optional[bool] = None


# ---------------------------------------------------------------- admin routes: polls


@router.get("/admin/feedback/polls")
def admin_list_polls(_admin: str = Depends(require_admin)):
    def run():
        now = _clock()
        ensure_monthly_drafts(now)
        forget_closed_voter_keys(now)
        polls = _load_polls(now)
        db = get_supabase()
        ids = [p["id"] for p in polls]
        counts: dict[str, int] = {}
        if ids:
            for row in _select_all(lambda: db.table(QUESTIONS).select("poll_id").in_("poll_id", ids)):
                counts[str(row["poll_id"])] = counts.get(str(row["poll_id"]), 0) + 1
        out = []
        for p in polls:
            started = p["status"] in ("open", "closed")
            participants = _participants(p["id"]) if started and counts.get(p["id"]) else 0
            out.append(_admin_summary(p, counts.get(p["id"], 0), participants))
        return out

    return _admin_guard(run)


@router.get("/admin/feedback/polls/{poll_id}")
def admin_get_poll(poll_id: str, _admin: str = Depends(require_admin)):
    def run():
        poll, missing = _admin_poll_or_404(poll_id, _clock())
        return missing or _admin_detail(poll)

    return _admin_guard(run)


@router.patch("/admin/feedback/polls/{poll_id}")
def admin_set_dates(poll_id: str, payload: DatesIn, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    try:
        opens = feedback_schedule.chicago_to_utc(feedback_schedule.parse_local(payload.opens_local))
        closes = feedback_schedule.chicago_to_utc(feedback_schedule.parse_local(payload.closes_local))
    except feedback_schedule.LocalTimeError as exc:
        return _error(422, exc.error_code, str(exc))
    if closes <= opens or closes - opens > timedelta(days=31):
        return _error(422, "bad_window", MSG_BAD_WINDOW)

    def run():
        now = _clock()
        poll, missing = _admin_poll_or_404(poll_id, now)
        if missing:
            return missing
        if poll["approved_at"] is not None:
            if poll["status"] != "scheduled":
                return _error(409, "wording_locked", MSG_WORDING_STARTED)
            if opens <= now:
                return _error(409, "opens_in_past", MSG_OPENS_IN_PAST)
            if _overlaps(poll["id"], opens, closes, now):
                return _error(409, "overlap", MSG_OVERLAP)
        get_supabase().table(POLLS).update({"opens_at": _iso(opens), "closes_at": _iso(closes)}).eq("id", poll["id"]).execute()
        logger.info("Feedback poll dates changed")
        return _admin_detail(_load_poll(poll["id"], now))

    return _admin_guard(run)


@router.put("/admin/feedback/polls/{poll_id}/questions")
def admin_save_questions(poll_id: str, payload: QuestionsIn, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    labels = [" ".join(q.label.split()) for q in payload.questions]
    if not 1 <= len(labels) <= MAX_QUESTIONS:
        return _error(422, "bad_questions", f"Use 1 to {MAX_QUESTIONS} questions.")
    if any(not 3 <= len(label) <= 160 for label in labels):
        return _error(422, "bad_questions", "Each question needs 3 to 160 characters.")
    if len({label.casefold() for label in labels}) != len(labels):
        return _error(422, "bad_questions", "Two questions are the same. Change or remove one.")

    def run():
        poll, missing = _admin_poll_or_404(poll_id, _clock())
        if missing:
            return missing
        if poll["approved_at"] is not None:
            started = poll["status"] in ("open", "closed")
            return _error(409, "wording_locked", MSG_WORDING_STARTED if started else MSG_WORDING_APPROVED)
        try:
            _run(lambda: get_supabase().rpc("feedback_save_questions", {"p_poll_id": poll["id"], "p_labels": labels}).execute())
        except Unavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            if "wording_locked" in _pg(exc)[1]:
                return _error(409, "wording_locked", MSG_WORDING_APPROVED)
            if _pg(exc)[0] == "23514":
                return _error(422, "bad_questions", "Each question needs 3 to 160 characters.")
            raise
        logger.info("Feedback questions saved count=%d", len(labels))
        return _admin_detail(poll)

    return _admin_guard(run)


@router.post("/admin/feedback/polls/{poll_id}/approve")
def admin_approve(poll_id: str, payload: ApproveIn, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    if not (payload.checklist.one_change_each and payload.checklist.yes_means_change):
        return _error(422, "checklist", MSG_CHECKLIST)

    def run():
        now = _clock()
        poll, missing = _admin_poll_or_404(poll_id, now)
        if missing:
            return missing
        if poll["approved_at"] is not None:
            return _admin_detail(poll)
        if not _questions(poll["id"]):
            return _error(422, "no_questions", MSG_NO_QUESTIONS)
        if poll["opens_at"] <= now:
            return _error(409, "opens_in_past", MSG_OPENS_IN_PAST)
        if _overlaps(poll["id"], poll["opens_at"], poll["closes_at"], now):
            return _error(409, "overlap", MSG_OVERLAP)
        get_supabase().table(POLLS).update({"approved_at": _iso(now)}).eq("id", poll["id"]).is_("approved_at", "null").execute()
        logger.info("Feedback poll approved")
        return _admin_detail(_load_poll(poll["id"], now))

    return _admin_guard(run)


@router.post("/admin/feedback/polls/{poll_id}/unapprove")
def admin_unapprove(poll_id: str, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited

    def run():
        now = _clock()
        poll, missing = _admin_poll_or_404(poll_id, now)
        if missing:
            return missing
        if poll["approved_at"] is None:
            return _admin_detail(poll)
        if poll["status"] != "scheduled":
            return _error(409, "wording_locked", MSG_WORDING_STARTED)
        get_supabase().table(POLLS).update({"approved_at": None}).eq("id", poll["id"]).execute()
        logger.info("Feedback poll moved back to draft")
        return _admin_detail(_load_poll(poll["id"], now))

    return _admin_guard(run)


@router.get("/admin/feedback/polls/{poll_id}/totals")
def admin_totals(poll_id: str, _admin: str = Depends(require_admin)):
    def run():
        now = _clock()
        poll, missing = _admin_poll_or_404(poll_id, now)
        if missing:
            return missing
        if poll["status"] not in ("open", "closed"):
            return _error(409, "not_open_yet", "Totals show up once the poll opens.")
        participants, questions = _totals(poll["id"])
        final = poll["status"] == "closed"
        # While the poll is open, only how many students answered: per-question counts
        # would let an admin see how one known student voted by watching them change.
        return {
            "participants": participants,
            "no_votes": participants == 0,
            "as_of": _iso(now),
            "final": final,
            "questions": questions if final else [],
        }

    return _admin_guard(run)


# ---------------------------------------------------------------- admin routes: comments and themes


def _comment_rows(poll_id: str) -> list[dict]:
    db = get_supabase()
    rows = _select_all(
        lambda: db.table(RESPONSES).select("id, comment, urgent_flags, urgent_set_by_admin").eq("poll_id", poll_id).order("id")
    )
    rows = [r for r in rows if r.get("comment")]
    # Random response id order, never newest first: the order must not hint who wrote what.
    rows.sort(key=lambda r: str(r["id"]))
    return rows


def _themes_and_members(poll_id: str) -> tuple[list[dict], list[dict]]:
    db = get_supabase()
    themes = _select_all(lambda: db.table(THEMES).select("id, label, term, source, created_at").eq("poll_id", poll_id).order("created_at"))
    members = _select_all(lambda: db.table(MEMBERS).select("theme_id, response_id, source").eq("poll_id", poll_id))
    return themes, members


def _comment_out(row: dict, theme_ids: list[str]) -> dict:
    rid = str(row["id"])
    # Comment text only: never who wrote it, and no time stamp to match against.
    return {
        "response_id": rid,
        "response_ref": rid.replace("-", "")[:8],
        "comment": row.get("comment"),
        "urgent_flags": list(row.get("urgent_flags") or []),
        "urgent_set_by_admin": bool(row.get("urgent_set_by_admin")),
        "theme_ids": theme_ids,
    }


def _themes_payload(poll_id: str) -> dict:
    comments = _comment_rows(poll_id)
    themes, members = _themes_and_members(poll_id)
    with_comment = {str(r["id"]) for r in comments}
    by_theme: dict[str, set[str]] = {}
    by_response: dict[str, list[str]] = {}
    for m in members:
        tid, rid = str(m["theme_id"]), str(m["response_id"])
        if rid not in with_comment:
            continue
        by_theme.setdefault(tid, set()).add(rid)
        by_response.setdefault(rid, []).append(tid)
    theme_out = [
        {
            "id": str(t["id"]),
            "label": t["label"],
            "source": t["source"],
            "count": len(by_theme.get(str(t["id"]), ())),
            "response_ids": sorted(by_theme.get(str(t["id"]), ())),
        }
        for t in themes
    ]
    theme_out.sort(key=lambda t: (-t["count"], t["label"].casefold(), t["id"]))
    urgent = [_comment_out(r, sorted(by_response.get(str(r["id"]), []))) for r in comments if r.get("urgent_flags")]
    other = [str(r["id"]) for r in comments if str(r["id"]) not in by_response]
    return {"urgent": urgent, "themes": theme_out, "other_count": len(other), "other_response_ids": other}


@router.get("/admin/feedback/polls/{poll_id}/comments")
def admin_comments(
    poll_id: str,
    theme_id: Optional[str] = Query(default=None, max_length=64),
    urgent: bool = False,
    _admin: str = Depends(require_admin),
):
    def run():
        poll, missing = _closed_poll_or_error(poll_id, _clock())
        if missing:
            return missing
        comments = _comment_rows(poll["id"])
        _themes, members = _themes_and_members(poll["id"])
        by_response: dict[str, list[str]] = {}
        for m in members:
            by_response.setdefault(str(m["response_id"]), []).append(str(m["theme_id"]))
        out = []
        for row in comments:
            tids = sorted(by_response.get(str(row["id"]), []))
            if theme_id is not None and theme_id not in tids:
                continue
            if urgent and not row.get("urgent_flags"):
                continue
            out.append(_comment_out(row, tids))
        return out

    return _admin_guard(run)


@router.get("/admin/feedback/polls/{poll_id}/themes")
def admin_themes(poll_id: str, _admin: str = Depends(require_admin)):
    def run():
        poll, missing = _closed_poll_or_error(poll_id, _clock())
        return missing or _themes_payload(poll["id"])

    return _admin_guard(run)


def regroup(poll_id: str) -> int:
    """Rebuild the automatic themes. Admin-made themes and admin-placed comments stay.

    A merged, split or renamed theme belongs to the admin: its term is never made into
    a new automatic theme again, and comments already in an admin theme are not
    grouped again (so a merge is never undone and nothing is counted twice).
    """
    db = get_supabase()
    comments = _comment_rows(poll_id)
    themes, members = _themes_and_members(poll_id)
    admin_member_themes = {str(m["theme_id"]) for m in members if m.get("source") == "admin"}
    kept = [t for t in themes if t.get("source") == "admin" or str(t["id"]) in admin_member_themes]
    kept_ids = {str(t["id"]) for t in kept}
    kept_terms = {t.get("term") for t in kept if t.get("term")}
    kept_labels = {str(t.get("label") or "").casefold() for t in kept}
    placed = {str(m["response_id"]) for m in members if str(m["theme_id"]) in kept_ids}
    _run(lambda: db.table(MEMBERS).delete().eq("poll_id", poll_id).eq("source", "auto").execute())
    for t in themes:
        if str(t["id"]) not in kept_ids:
            _run(lambda tid=str(t["id"]): db.table(THEMES).delete().eq("id", tid).execute())
    grouped = feedback_themes.group_comments((str(r["id"]), r.get("comment") or "") for r in comments)
    made = 0
    for group in grouped["themes"]:
        if group["term"] in kept_terms or group["label"].casefold() in kept_labels:
            continue
        ids = [rid for rid in group["response_ids"] if rid not in placed]
        if len(ids) < 2:
            continue
        inserted = _rows(
            _run(
                lambda g=group: db.table(THEMES)
                .insert({"poll_id": poll_id, "label": g["label"], "term": g["term"], "source": "auto"})
                .execute()
            )
        )
        theme_id = str(inserted[0]["id"])
        rows = [{"theme_id": theme_id, "poll_id": poll_id, "response_id": rid, "source": "auto"} for rid in ids]
        _run(lambda r=rows: db.table(MEMBERS).insert(r).execute())
        made += 1
    logger.info("Feedback regroup comments=%d themes=%d", len(comments), made)
    return made


@router.post("/admin/feedback/polls/{poll_id}/themes/regroup")
def admin_regroup(poll_id: str, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    if not regroup_limiter.hit(admin_id):
        return _error(429, "rate_limited", MSG_RATE_LIMITED)

    def run():
        poll, missing = _closed_poll_or_error(poll_id, _clock())
        if missing:
            return missing
        regroup(poll["id"])
        return _themes_payload(poll["id"])

    return _admin_guard(run)


def _theme(theme_id: str) -> Optional[dict]:
    if _uuid_or_none(theme_id) is None:
        return None
    rows = _rows(_run(lambda: get_supabase().table(THEMES).select("id, poll_id, label, term, source").eq("id", theme_id).limit(1).execute()))
    return rows[0] if rows else None


def _make_admin_owned(theme_id: str) -> None:
    db = get_supabase()
    db.table(THEMES).update({"source": "admin"}).eq("id", theme_id).execute()
    db.table(MEMBERS).update({"source": "admin"}).eq("theme_id", theme_id).execute()


def _member_ids(theme_id: str) -> set[str]:
    db = get_supabase()
    return {str(m["response_id"]) for m in _select_all(lambda: db.table(MEMBERS).select("response_id").eq("theme_id", theme_id))}


@router.post("/admin/feedback/themes/merge")
def admin_merge_themes(payload: MergeIn, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    poll_id = str(payload.poll_id)
    into = str(payload.into_theme_id)
    sources = sorted({str(t) for t in payload.from_theme_ids} - {into})

    def run():
        db = get_supabase()
        _poll_row, not_closed = _closed_poll_or_error(poll_id, _clock())
        if not_closed:
            return not_closed
        target = _theme(into)
        if target is None or str(target["poll_id"]) != poll_id:
            return _error(404, "theme_not_found", "We couldn't find that theme.")
        found = [_theme(t) for t in sources]
        if any(t is None or str(t["poll_id"]) != poll_id for t in found):
            # A retry after a merge that already finished: the sources are gone.
            if all(t is None for t in found):
                return _themes_payload(poll_id)
            return _error(404, "theme_not_found", "We couldn't find that theme.")
        have = _member_ids(into)
        moving: set[str] = set()
        for t in sources:
            moving |= _member_ids(t)
        rows = [{"theme_id": into, "poll_id": poll_id, "response_id": rid, "source": "admin"} for rid in sorted(moving - have)]
        if rows:
            db.table(MEMBERS).insert(rows).execute()
        for t in sources:
            db.table(THEMES).delete().eq("id", t).execute()
        _make_admin_owned(into)
        logger.info("Feedback themes merged count=%d", len(sources))
        return _themes_payload(poll_id)

    return _admin_guard(run)


@router.post("/admin/feedback/themes/{theme_id}/split")
def admin_split_theme(theme_id: str, payload: SplitIn, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    label = " ".join(payload.label.split())
    if not label:
        return _error(422, "bad_label", "Give the new theme a name.")
    moving = {str(r) for r in payload.response_ids}

    def run():
        db = get_supabase()
        source = _theme(theme_id)
        if source is None:
            return _error(404, "theme_not_found", "We couldn't find that theme.")
        poll_id = str(source["poll_id"])
        _poll_row, not_closed = _closed_poll_or_error(poll_id, _clock())
        if not_closed:
            return not_closed
        if not moving <= _member_ids(str(source["id"])):
            return _error(422, "bad_members", "Pick comments that are in this theme.")
        new = _rows(db.table(THEMES).insert({"poll_id": poll_id, "label": label, "term": None, "source": "admin"}).execute())
        new_id = str(new[0]["id"])
        db.table(MEMBERS).insert(
            [{"theme_id": new_id, "poll_id": poll_id, "response_id": rid, "source": "admin"} for rid in sorted(moving)]
        ).execute()
        for rid in sorted(moving):
            db.table(MEMBERS).delete().eq("theme_id", str(source["id"])).eq("response_id", rid).execute()
        _make_admin_owned(str(source["id"]))
        logger.info("Feedback theme split moved=%d", len(moving))
        return _themes_payload(poll_id)

    return _admin_guard(run)


@router.patch("/admin/feedback/themes/{theme_id}")
def admin_rename_theme(theme_id: str, payload: RenameIn, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    label = " ".join(payload.label.split())
    if not label:
        return _error(422, "bad_label", "Give the theme a name.")

    def run():
        theme = _theme(theme_id)
        if theme is None:
            return _error(404, "theme_not_found", "We couldn't find that theme.")
        _poll_row, not_closed = _closed_poll_or_error(str(theme["poll_id"]), _clock())
        if not_closed:
            return not_closed
        get_supabase().table(THEMES).update({"label": label}).eq("id", str(theme["id"])).execute()
        _make_admin_owned(str(theme["id"]))
        return _themes_payload(str(theme["poll_id"]))

    return _admin_guard(run)


@router.delete("/admin/feedback/themes/{theme_id}")
def admin_delete_theme(theme_id: str, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited

    def run():
        theme = _theme(theme_id)
        if theme is None:
            return _error(404, "theme_not_found", "We couldn't find that theme.")
        _poll_row, not_closed = _closed_poll_or_error(str(theme["poll_id"]), _clock())
        if not_closed:
            return not_closed
        get_supabase().table(THEMES).delete().eq("id", str(theme["id"])).execute()
        return _themes_payload(str(theme["poll_id"]))

    return _admin_guard(run)


@router.patch("/admin/feedback/responses/{response_id}")
def admin_set_flags(response_id: str, payload: FlagsIn, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    flags = [kind for kind in feedback_text.URGENT_KINDS if kind in set(payload.urgent_flags)]

    def run():
        if _uuid_or_none(response_id) is None:
            return _error(404, "response_not_found", "We couldn't find that comment.")
        db = get_supabase()
        rows = _rows(_run(lambda: db.table(RESPONSES).select("id, poll_id, comment").eq("id", response_id).limit(1).execute()))
        if not rows or not rows[0].get("comment"):
            return _error(404, "response_not_found", "We couldn't find that comment.")
        _poll_row, not_closed = _closed_poll_or_error(str(rows[0]["poll_id"]), _clock())
        if not_closed:
            return not_closed
        db.table(RESPONSES).update({"urgent_flags": flags, "urgent_set_by_admin": True}).eq("id", response_id).execute()
        row = _rows(db.table(RESPONSES).select("id, comment, urgent_flags, urgent_set_by_admin").eq("id", response_id).limit(1).execute())[0]
        members = _select_all(lambda: db.table(MEMBERS).select("theme_id").eq("response_id", response_id))
        return _comment_out(row, sorted(str(m["theme_id"]) for m in members))

    return _admin_guard(run)


# ---------------------------------------------------------------- admin routes: updates for students


def _update_out(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "poll_id": str(row["poll_id"]),
        "position": int(row.get("position") or 1),
        "title": row["title"],
        "status": row["status"],
        "note": row.get("note"),
        "published": bool(row.get("published")),
    }


def _updates(poll_id: str) -> list[dict]:
    db = get_supabase()
    rows = _select_all(lambda: db.table(UPDATES).select("*").eq("poll_id", poll_id).order("position"))
    rows.sort(key=lambda r: (int(r.get("position") or 0), str(r.get("created_at") or "")))
    return [_update_out(r) for r in rows]


@router.get("/admin/feedback/polls/{poll_id}/updates")
def admin_list_updates(poll_id: str, _admin: str = Depends(require_admin)):
    def run():
        poll, missing = _admin_poll_or_404(poll_id, _clock())
        return missing or _updates(poll["id"])

    return _admin_guard(run)


@router.post("/admin/feedback/polls/{poll_id}/updates", status_code=201)
def admin_create_update(poll_id: str, payload: UpdateCreate, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited

    def run():
        poll, missing = _admin_poll_or_404(poll_id, _clock())
        if missing:
            return missing
        position = payload.position or min(50, len(_updates(poll["id"])) + 1)
        row = _rows(
            get_supabase()
            .table(UPDATES)
            .insert(
                {
                    "poll_id": poll["id"],
                    "position": position,
                    "title": payload.title.strip(),
                    "status": payload.status,
                    "note": (payload.note or "").strip() or None,
                    "published": payload.published,
                }
            )
            .execute()
        )[0]
        return JSONResponse(status_code=201, content=_update_out(row))

    return _admin_guard(run)


@router.patch("/admin/feedback/updates/{update_id}")
def admin_patch_update(update_id: str, payload: UpdatePatch, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited
    changes = payload.model_dump(exclude_unset=True)
    if "title" in changes:
        if changes["title"] is None or not changes["title"].strip():
            return _error(422, "bad_title", "Give the update a title.")
        changes["title"] = changes["title"].strip()
    if "note" in changes:
        changes["note"] = (changes["note"] or "").strip() or None
    for key in ("status", "position", "published"):
        if key in changes and changes[key] is None:
            changes.pop(key)

    def run():
        if _uuid_or_none(update_id) is None:
            return _error(404, "update_not_found", "We couldn't find that update.")
        db = get_supabase()
        if changes:
            rows = _rows(_run(lambda: db.table(UPDATES).update(changes).eq("id", update_id).execute()))
        else:
            rows = _rows(_run(lambda: db.table(UPDATES).select("*").eq("id", update_id).limit(1).execute()))
        if not rows:
            return _error(404, "update_not_found", "We couldn't find that update.")
        return _update_out(rows[0])

    return _admin_guard(run)


@router.delete("/admin/feedback/updates/{update_id}")
def admin_delete_update(update_id: str, admin_id: str = Depends(require_admin)):
    limited = _admin_limited(admin_id)
    if limited:
        return limited

    def run():
        if _uuid_or_none(update_id) is None:
            return _error(404, "update_not_found", "We couldn't find that update.")
        rows = _rows(_run(lambda: get_supabase().table(UPDATES).delete().eq("id", update_id).execute()))
        if not rows:
            return _error(404, "update_not_found", "We couldn't find that update.")
        return {"deleted": True}

    return _admin_guard(run)
