"""Monthly feedback schedule: last Sunday of the month, noon to noon, America/Chicago."""

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app import feedback_schedule as fs

UTC = timezone.utc


def z(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def test_time_zone_database_loads():
    assert ZoneInfo("America/Chicago") is not None
    assert fs.CHICAGO.key == "America/Chicago"


@pytest.mark.parametrize(
    "year,month,sunday,opens,closes,hours",
    [
        (2026, 1, 25, "2026-01-25T18:00Z", "2026-02-01T18:00Z", 168),
        (2026, 2, 22, "2026-02-22T18:00Z", "2026-03-01T18:00Z", 168),  # closes a week before DST starts
        (2026, 3, 29, "2026-03-29T17:00Z", "2026-04-05T17:00Z", 168),  # March: already on CDT
        (2026, 5, 31, "2026-05-31T17:00Z", "2026-06-07T17:00Z", 168),  # month ends on a Sunday (5 Sundays)
        (2026, 10, 25, "2026-10-25T17:00Z", "2026-11-01T18:00Z", 169),  # clocks fall back before the close
        (2026, 11, 29, "2026-11-29T18:00Z", "2026-12-06T18:00Z", 168),  # November: 5 Sundays (1st is a Sunday)
        (2026, 12, 27, "2026-12-27T18:00Z", "2027-01-03T18:00Z", 168),  # rolls over the year
        (2027, 2, 28, "2027-02-28T18:00Z", "2027-03-07T18:00Z", 168),
        (2027, 3, 28, "2027-03-28T17:00Z", "2027-04-04T17:00Z", 168),
        (2027, 10, 31, "2027-10-31T17:00Z", "2027-11-07T18:00Z", 169),  # 5 Sundays; DST ends on the close day
        (2027, 11, 28, "2027-11-28T18:00Z", "2027-12-05T18:00Z", 168),
    ],
)
def test_exact_windows(year, month, sunday, opens, closes, hours):
    assert fs.last_sunday(year, month) == date(year, month, sunday)
    o, c = fs.default_window(year, month)
    assert (o, c) == (z(opens), z(closes))
    assert (c - o).total_seconds() == hours * 3600


def test_october_close_is_noon_not_open_plus_168_hours():
    o, c = fs.default_window(2026, 10)
    assert c != o + timedelta(hours=168)
    assert c.astimezone(fs.CHICAGO).hour == 12


@pytest.mark.parametrize("year,month", [(2026, 3), (2026, 11), (2027, 3), (2027, 11)])
def test_march_and_november_open_and_close_at_noon_central(year, month):
    o, c = fs.default_window(year, month)
    for instant in (o, c):
        local = instant.astimezone(fs.CHICAGO)
        assert (local.hour, local.minute, local.weekday()) == (12, 0, 6)


def test_every_month_2026_to_2045():
    previous_close = None
    for year in range(2026, 2046):
        for month in range(1, 13):
            o, c = fs.default_window(year, month)
            lo, lc = o.astimezone(fs.CHICAGO), c.astimezone(fs.CHICAGO)
            assert lo.weekday() == 6 and lc.weekday() == 6
            assert (lo.hour, lo.minute, lc.hour, lc.minute) == (12, 0, 12, 0)
            assert (lo.year, lo.month) == (year, month)
            assert (lo + timedelta(days=7)).month != month  # really the LAST Sunday
            assert (lc.date() - lo.date()).days == 7
            hours = (c.astimezone(UTC) - o.astimezone(UTC)).total_seconds() / 3600
            assert hours == (169 if month == 10 else 168)
            if previous_close is not None:
                assert previous_close < o  # windows never overlap
            previous_close = c


def test_last_sunday_for_every_kind_of_month_end():
    seen_weekdays = set()
    for year in range(2026, 2036):
        for month in range(1, 13):
            sunday = fs.last_sunday(year, month)
            assert sunday.weekday() == 6 and sunday.month == month
            assert (sunday + timedelta(days=7)).month != month
            end = fs.next_month(date(year, month, 1)) - timedelta(days=1)
            seen_weekdays.add(end.weekday())
            assert 0 <= (end - sunday).days <= 6
    assert seen_weekdays == set(range(7))


def test_months_with_five_sundays():
    assert fs.last_sunday(2026, 11) == date(2026, 11, 29)  # Sundays 1, 8, 15, 22, 29
    assert fs.last_sunday(2026, 5) == date(2026, 5, 31)  # Sundays 3, 10, 17, 24, 31
    assert fs.last_sunday(2027, 2) == date(2027, 2, 28)  # February ending on a Sunday


def test_month_rollover():
    assert fs.next_month(date(2026, 12, 1)) == date(2027, 1, 1)
    assert fs.chicago_month(datetime(2027, 1, 1, 3, tzinfo=UTC)) == date(2026, 12, 1)  # still Dec 31 in Chicago


def test_local_time_conversion():
    with pytest.raises(fs.NonexistentLocalTime):
        fs.chicago_to_utc(datetime(2027, 3, 14, 2, 30))
    with pytest.raises(fs.NonexistentLocalTime):
        fs.chicago_to_utc(datetime(2026, 3, 8, 2, 30))
    for value in (datetime(2026, 11, 1, 1, 30), datetime(2027, 11, 7, 1, 30)):
        with pytest.raises(fs.AmbiguousLocalTime):
            fs.chicago_to_utc(value)
    assert fs.chicago_to_utc(datetime(2027, 3, 14, 1, 59)) == z("2027-03-14T07:59Z")
    assert fs.chicago_to_utc(datetime(2027, 3, 14, 3, 0)) == z("2027-03-14T08:00Z")
    with pytest.raises(ValueError):
        fs.chicago_to_utc(datetime(2026, 1, 1, tzinfo=UTC))
    assert fs.utc_to_chicago_local(z("2026-11-01T18:00Z")) == "2026-11-01T12:00"
    assert fs.parse_local("2026-12-01T12:00") == datetime(2026, 12, 1, 12)
    with pytest.raises(fs.LocalTimeError):
        fs.parse_local("2026-12-01T12:00+00:00")


def test_status_at_the_exact_second():
    o, c = fs.default_window(2026, 11)
    poll = fs.PollTimes(o, c, approved_at=o - timedelta(days=3))
    s = lambda t: fs.poll_status(poll, t)  # noqa: E731
    assert [s(o - timedelta(seconds=1)), s(o - timedelta(microseconds=1)), s(o), s(o + timedelta(seconds=1))] == [
        "scheduled", "scheduled", "open", "open"]
    assert [s(c - timedelta(seconds=1)), s(c - timedelta(microseconds=1)), s(c), s(c + timedelta(seconds=1))] == [
        "open", "open", "closed", "closed"]
    draft = fs.PollTimes(o, c)
    assert fs.poll_status(draft, o - timedelta(seconds=1)) == "draft"
    assert fs.poll_status(draft, o) == "missed"
    with pytest.raises(ValueError):
        fs.poll_status(poll, datetime(2026, 1, 1))
