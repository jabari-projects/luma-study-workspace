"""Monthly feedback poll schedule math (pure: no I/O, never reads the clock).

Default window: the poll opens on the LAST Sunday of its month at 12:00 noon
America/Chicago and closes the following Sunday at 12:00 noon Chicago time.
The close is worked out by adding 7 days to the calendar DATE and converting
noon on that date, never by adding 168 hours to an instant, so a window that
crosses a daylight-saving change still ends at noon local time (the October
poll, which closes on the first Sunday of November after clocks fall back,
lasts 169 real hours).

Status is worked out from the clock. The voting window is half-open:
[opens_at, closes_at). Exactly at closes_at the poll is closed.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

UTC = timezone.utc
SCHEDULE_TZ_NAME = "America/Chicago"
# Loaded at import so a missing time zone database fails at startup, not mid-request.
CHICAGO = ZoneInfo(SCHEDULE_TZ_NAME)
OPEN_HOUR = 12
WINDOW_DAYS = 7

DST_MESSAGE = (
    "That time is skipped or happens twice in Central time because of daylight saving. Pick another time."
)


class LocalTimeError(ValueError):
    error_code = "bad_local_time"


class NonexistentLocalTime(LocalTimeError):
    error_code = "nonexistent_local_time"


class AmbiguousLocalTime(LocalTimeError):
    error_code = "ambiguous_local_time"


def last_sunday(year: int, month: int) -> date:
    last_day = date(year, month, calendar.monthrange(year, month)[1])
    # weekday(): Monday=0 ... Sunday=6
    return last_day - timedelta(days=(last_day.weekday() - 6) % 7)


def chicago_to_utc(naive: datetime) -> datetime:
    """Convert a Chicago wall-clock time (no tzinfo) to UTC.

    Raises NonexistentLocalTime for times skipped by the spring-forward change
    and AmbiguousLocalTime for times that happen twice in the fall.
    """
    if naive.tzinfo is not None:
        raise ValueError("expected a naive Chicago wall-clock time")
    first = naive.replace(tzinfo=CHICAGO, fold=0)
    second = naive.replace(tzinfo=CHICAGO, fold=1)
    round_trip = first.astimezone(UTC).astimezone(CHICAGO).replace(tzinfo=None)
    if round_trip != naive:
        raise NonexistentLocalTime(DST_MESSAGE)
    if first.utcoffset() != second.utcoffset():
        raise AmbiguousLocalTime(DST_MESSAGE)
    return first.astimezone(UTC)


def utc_to_chicago_local(instant: datetime) -> str:
    """'YYYY-MM-DDTHH:MM' in Chicago time (the value a datetime-local input uses)."""
    return instant.astimezone(CHICAGO).strftime("%Y-%m-%dT%H:%M")


def parse_local(value: str) -> datetime:
    """Parse 'YYYY-MM-DDTHH:MM' (seconds optional) as a naive wall-clock time."""
    if not isinstance(value, str) or len(value) > 19:
        raise LocalTimeError("Use the format YYYY-MM-DDTHH:MM.")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise LocalTimeError("Use the format YYYY-MM-DDTHH:MM.") from exc
    if parsed.tzinfo is not None:
        raise LocalTimeError("Use Central time without a time zone.")
    return parsed


def default_window(year: int, month: int) -> tuple[datetime, datetime]:
    opens_day = last_sunday(year, month)
    closes_day = opens_day + timedelta(days=WINDOW_DAYS)
    return (
        chicago_to_utc(datetime.combine(opens_day, time(OPEN_HOUR))),
        chicago_to_utc(datetime.combine(closes_day, time(OPEN_HOUR))),
    )


def chicago_month(now: datetime) -> date:
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    local = now.astimezone(CHICAGO)
    return date(local.year, local.month, 1)


def next_month(month: date) -> date:
    return date(month.year + 1, 1, 1) if month.month == 12 else date(month.year, month.month + 1, 1)


@dataclass(frozen=True)
class PollTimes:
    opens_at: datetime
    closes_at: datetime
    approved_at: Optional[datetime] = None


def poll_status(poll: PollTimes, now: datetime) -> str:
    """draft | missed | scheduled | open | closed."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    if poll.approved_at is None:
        return "missed" if now >= poll.opens_at else "draft"
    if now < poll.opens_at:
        return "scheduled"
    if now < poll.closes_at:
        return "open"
    return "closed"
