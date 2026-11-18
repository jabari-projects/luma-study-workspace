"""Chicago time and daylight saving for the maintenance schedule (no network, no real data).

The admin types Central times. A time that is skipped when clocks spring forward, or that
happens twice when they fall back, is refused with a plain message. Times on both sides of
a change land on the right UTC instant (CST is UTC-6, CDT is UTC-5).
"""

from datetime import datetime, timezone

import pytest

from app import maintenance
from tests.maintenance_fakes import world  # noqa: F401


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "local,expected",
    [
        ("2026-12-01T05:00", utc(2026, 12, 1, 11, 0)),  # CST
        ("2027-06-01T05:00", utc(2027, 6, 1, 10, 0)),  # CDT
        ("2027-03-14T01:59", utc(2027, 3, 14, 7, 59)),  # just before spring forward (CST)
        ("2027-03-14T03:00", utc(2027, 3, 14, 8, 0)),  # just after (CDT)
        ("2027-11-07T00:59", utc(2027, 11, 7, 5, 59)),  # just before fall back (CDT)
        ("2027-11-07T02:00", utc(2027, 11, 7, 8, 0)),  # just after (CST)
    ],
)
def test_central_times_convert_on_both_sides_of_a_change(local, expected):
    assert maintenance.chicago_to_utc(local) == expected


@pytest.mark.parametrize("local", ["2027-03-14T02:00", "2027-03-14T02:30", "2027-03-14T02:59", "2026-03-08T02:15"])
def test_skipped_times_are_refused(local):
    with pytest.raises(maintenance.TimeChoiceError) as info:
        maintenance.chicago_to_utc(local)
    assert info.value.code == "time_skipped"
    assert info.value.message == "That time is skipped when clocks change. Pick another time."


@pytest.mark.parametrize("local", ["2027-11-07T01:00", "2027-11-07T01:30", "2027-11-07T01:59", "2026-11-01T01:15"])
def test_doubled_times_are_refused(local):
    with pytest.raises(maintenance.TimeChoiceError) as info:
        maintenance.chicago_to_utc(local)
    assert info.value.code == "time_twice"
    assert info.value.message == "That time happens twice when clocks change. Pick another time."


@pytest.mark.parametrize("bad", ["", "tomorrow", "2027-02-30T05:00", "2027-01-01T05:00:00", "2027-01-01T05:00Z", None])
def test_other_bad_values_are_refused(bad):
    with pytest.raises(maintenance.TimeChoiceError) as info:
        maintenance.chicago_to_utc(bad)
    assert info.value.code == "time_invalid"


def test_the_schedule_route_refuses_dst_times(world):
    skipped = world.schedule(start="2027-03-14T02:30", end="2027-03-14T04:00")
    assert skipped.status_code == 422 and skipped.json()["error_code"] == "time_skipped"
    twice = world.schedule(start="2027-11-07T01:30", end="2027-11-07T03:00")
    assert twice.status_code == 422 and twice.json()["error_code"] == "time_twice"
    end_twice = world.schedule(start="2027-11-07T00:30", end="2027-11-07T01:30")
    assert end_twice.status_code == 422 and end_twice.json()["error_code"] == "time_twice"
    assert world.db.state["phase"] == "none"


def test_a_break_across_the_fall_back_change_is_stored_in_utc(world):
    # 12:30 AM CDT to 2:30 AM CST is three real hours.
    response = world.schedule(start="2027-11-07T00:30", end="2027-11-07T02:30")
    assert response.status_code == 200
    state = world.db.state
    assert state["start_at"] == "2027-11-07T05:30:00Z"
    assert state["estimated_end_at"] == "2027-11-07T08:30:00Z"
    status = world.signed_out().get("/maintenance/status").json()
    assert status["start_at"] == "2027-11-07T05:30:00Z"
