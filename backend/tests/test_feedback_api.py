"""Monthly feedback poll routes: students, admins, privacy and account deletion.

In-memory fake database only (tests/feedback_fake.py): no Supabase, no network.
"""

from __future__ import annotations

import ast
import json
import logging
import socket
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import account_deletion as ad
from app import auth, feedback, feedback_text, main
from app.auth import get_current_user_id
from tests.feedback_fake import FakeAPIError, FeedbackFake

UTC = timezone.utc
NOW = datetime(2026, 11, 30, 12, 0, tzinfo=UTC)  # inside the Nov 2026 poll (Nov 29 - Dec 6)
AFTER_CLOSE = datetime(2026, 12, 7, tzinfo=UTC)
SENTINEL = "SENTINEL-COMMENT-7"


@pytest.fixture
def env(monkeypatch):
    clock = {"t": NOW}
    fake = FeedbackFake(lambda: clock["t"])
    monkeypatch.setattr(feedback, "get_supabase", lambda: fake)
    monkeypatch.setattr(auth, "get_supabase", lambda: fake)
    monkeypatch.setattr(feedback, "_clock", lambda: clock["t"])
    monkeypatch.delenv(feedback.VOTER_KEY_SECRET_ENV, raising=False)
    for limiter in feedback.LIMITERS:
        limiter.clear()
    feedback._forget_state["last"] = None
    yield SimpleNamespace(db=fake, clock=clock)
    for limiter in feedback.LIMITERS:
        limiter.clear()
    feedback._forget_state["last"] = None
    main.app.dependency_overrides.pop(get_current_user_id, None)


def client_for(user_id):
    main.app.dependency_overrides[get_current_user_id] = lambda: user_id
    return TestClient(main.app)


def iso(dt):
    return dt.astimezone(UTC).isoformat()


def seed_poll(db, opens, closes, labels=("Add a dark mode", "Make cards load faster", "Add a phone app"),
              approved=True, month=None):
    poll = {
        "id": str(uuid.uuid4()),
        "period_month": month or opens.strftime("%Y-%m-01"),
        "opens_at": iso(opens),
        "closes_at": iso(closes),
        "approved_at": iso(opens - timedelta(days=3)) if approved else None,
        "created_at": iso(opens - timedelta(days=30)),
    }
    db.rows("feedback_polls").append(poll)
    qids = []
    for i, label in enumerate(labels, start=1):
        qid = str(uuid.uuid4())
        db.rows("feedback_questions").append({"id": qid, "poll_id": poll["id"], "position": i, "label": label})
        qids.append(qid)
    return poll["id"], qids


@pytest.fixture
def open_poll(env):
    return seed_poll(env.db, datetime(2026, 11, 29, 18, tzinfo=UTC), datetime(2026, 12, 6, 18, tzinfo=UTC))


@pytest.fixture
def student(env):
    return env.db.user(email="Sam.Student+poll@gmail.com", verified=True)


@pytest.fixture
def admin(env):
    return env.db.user(email="admin@example.com", verified=True, role="admin")


def close_poll(env):
    """Admins see comments, themes and per-question counts only after the poll closes."""
    env.clock["t"] = AFTER_CLOSE


def vote(client, poll_id, answers, comment=None):
    return client.post(
        f"/feedback/polls/{poll_id}/responses",
        json={"answers": [{"question_id": q, "choice": c} for q, c in answers], "comment": comment},
    )


def walk(value):
    """Every key and scalar value in a JSON payload."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk(v)
    else:
        yield value


# ---------------------------------------------------------------- student: current poll


def test_current_without_tables_is_empty_not_an_error(env, student):
    env.db.missing.add("feedback_polls")
    r = client_for(student["id"]).get("/feedback/current")
    assert r.status_code == 200 and r.json()["poll"] is None and r.json()["can_vote"] is False


def test_current_shows_open_poll_without_counts(env, student, open_poll):
    poll_id, qids = open_poll
    body = client_for(student["id"]).get("/feedback/current").json()
    poll = body["poll"]
    assert poll["id"] == poll_id and poll["status"] == "open"
    assert poll["title"] == "If it ain't broke why fix it?!"
    assert poll["intro"] == (
        "Help us make Luma better! Answer a few quick questions about what should change. "
        "You can skip this poll. Your answers help us choose what to work on next."
    )
    assert poll["privacy_note"] == "Admins can't see who wrote your answers."
    assert poll["comment_hint"] == "Please don't include passwords or private information."
    assert poll["comment_max"] == 500
    assert [q["id"] for q in poll["questions"]] == qids
    assert body["can_vote"] is True and body["my_response"] is None and body["skipped"] is False
    assert body["schedule_tz"] == "America/Chicago"
    keys = set(walk(body))
    for banned in ("participants", "yes", "no", "yes_count", "comments", "user_id", "email"):
        assert banned not in keys


def test_drafts_and_missed_polls_are_never_shown(env, student):
    seed_poll(env.db, NOW - timedelta(hours=1), NOW + timedelta(days=5), approved=False)
    body = client_for(student["id"]).get("/feedback/current").json()
    assert body["poll"] is None


def test_next_opens_at_and_latest_results(env, student):
    seed_poll(env.db, NOW + timedelta(days=20), NOW + timedelta(days=27), month="2026-12-01")
    closed_id, _ = seed_poll(env.db, NOW - timedelta(days=10), NOW - timedelta(days=3), month="2026-10-01")
    body = client_for(student["id"]).get("/feedback/current").json()
    assert body["next_opens_at"].startswith((NOW + timedelta(days=20)).strftime("%Y-%m-%dT%H"))
    assert body["latest_results"]["poll_id"] == closed_id
    env.clock["t"] = NOW + timedelta(days=12)
    assert client_for(student["id"]).get("/feedback/current").json()["latest_results"] is None


# ---------------------------------------------------------------- student: voting


def test_vote_once_then_retry_is_acknowledged(env, student, open_poll):
    poll_id, qids = open_poll
    c = client_for(student["id"])
    first = vote(c, poll_id, [(qids[0], "yes"), (qids[1], "no")], "Please add a dark mode")
    assert first.status_code == 201 and first.json()["status"] == "received"
    assert first.json()["message"] == "Thanks! We got your answers."
    again = vote(c, poll_id, [(qids[0], "no")])
    assert again.status_code == 200 and again.json()["status"] == "already_received"
    assert again.json()["message"] == "We already have your answers for this poll. Thanks!"
    assert len(env.db.rows("feedback_responses")) == 1
    answers = {a["question_id"]: a["wants_change"] for a in env.db.rows("feedback_answers")}
    assert answers == {qids[0]: True, qids[1]: False}
    mine = c.get("/feedback/current").json()
    assert mine["can_vote"] is False
    assert {a["question_id"]: a["choice"] for a in mine["my_response"]["answers"]} == {qids[0]: "yes", qids[1]: "no"}
    assert mine["my_response"]["comment"] == "Please add a dark mode"


def test_concurrent_sends_make_one_ballot(env, student, open_poll):
    poll_id, qids = open_poll
    c = client_for(student["id"])
    codes = []
    barrier = threading.Barrier(20)

    def send():
        barrier.wait()
        codes.append(vote(c, poll_id, [(qids[0], "yes")]).status_code)

    threads = [threading.Thread(target=send) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [200] * 19 + [201]
    assert len(env.db.rows("feedback_responses")) == 1


def test_two_students_two_ballots(env, student, open_poll):
    poll_id, qids = open_poll
    other = env.db.user(email="other@example.com")
    assert vote(client_for(student["id"]), poll_id, [(qids[0], "yes")]).status_code == 201
    assert vote(client_for(other["id"]), poll_id, [(qids[0], "no")]).status_code == 201
    assert len(env.db.rows("feedback_responses")) == 2


def test_same_email_on_a_new_account_cannot_vote_twice(env, student, open_poll):
    poll_id, qids = open_poll
    assert vote(client_for(student["id"]), poll_id, [(qids[0], "yes")]).status_code == 201
    report = ad.step_anonymize_feedback(student["id"], ad.DeletionDeps(db=env.db))
    assert report.outcome == ad.ANONYMIZED
    env.db.tables["users"] = [u for u in env.db.rows("users") if u["id"] != student["id"]]
    # Same inbox, written differently (Gmail ignores dots and +tags).
    reborn = env.db.user(email="samstudent@gmail.com")
    c = client_for(reborn["id"])
    r = vote(c, poll_id, [(qids[0], "no")])
    assert r.status_code == 200 and r.json()["status"] == "already_received"
    assert len(env.db.rows("feedback_responses")) == 1
    current = c.get("/feedback/current").json()
    assert current["can_vote"] is False and current["my_response"]["answers"] == []


def test_unique_violation_from_the_database_is_reread(env, student, open_poll):
    poll_id, qids = open_poll

    def racing_insert(name, params):
        if name == "feedback_submit":
            env.db.rows("feedback_responses").append(
                {"id": str(uuid.uuid4()), "poll_id": poll_id, "user_id": student["id"], "voter_key": params["p_voter_key"],
                 "comment": None, "urgent_flags": [], "urgent_set_by_admin": False, "submitted_at": iso(NOW)}
            )
            env.db.rpc_hook = None
            raise FakeAPIError("23505", "duplicate key value violates unique constraint")

    env.db.rpc_hook = racing_insert
    r = vote(client_for(student["id"]), poll_id, [(qids[0], "yes")])
    assert r.status_code == 200 and r.json()["status"] == "already_received"


def test_retry_after_close_by_a_voter_is_200(env, student, open_poll):
    poll_id, qids = open_poll
    c = client_for(student["id"])
    assert vote(c, poll_id, [(qids[0], "yes")]).status_code == 201
    env.clock["t"] = datetime(2026, 12, 6, 18, 0, 1, tzinfo=UTC)
    assert vote(c, poll_id, [(qids[0], "yes")]).status_code == 200


@pytest.mark.parametrize(
    "body,code",
    [
        ("dup", "bad_answers"),
        ("other_poll", "unknown_question"),
        ("maybe", None),
        ("user_id", None),
        ("empty", "empty_response"),
        ("blank_comment", "empty_response"),
        ("not_uuid", None),
    ],
)
def test_bad_ballots_write_nothing(env, student, open_poll, body, code):
    poll_id, qids = open_poll
    _other_poll, other_qids = seed_poll(env.db, NOW + timedelta(days=40), NOW + timedelta(days=47), month="2027-01-01")
    payloads = {
        "dup": {"answers": [{"question_id": qids[0], "choice": "yes"}, {"question_id": qids[0], "choice": "no"}]},
        "other_poll": {"answers": [{"question_id": other_qids[0], "choice": "yes"}]},
        "maybe": {"answers": [{"question_id": qids[0], "choice": "maybe"}]},
        "user_id": {"answers": [{"question_id": qids[0], "choice": "yes"}], "user_id": "someone-else"},
        "empty": {"answers": []},
        "blank_comment": {"answers": [], "comment": "   \n\t "},
        "not_uuid": {"answers": [{"question_id": "abc", "choice": "yes"}]},
    }
    r = client_for(student["id"]).post(f"/feedback/polls/{poll_id}/responses", json=payloads[body])
    assert r.status_code == 422
    if code:
        assert r.json()["error_code"] == code
    assert env.db.rows("feedback_responses") == [] and env.db.rows("feedback_answers") == []


def test_vote_rate_limit(env, student, open_poll):
    poll_id, qids = open_poll
    c = client_for(student["id"])
    codes = [vote(c, poll_id, [(qids[0], "yes")]).status_code for _ in range(feedback.VOTES_PER_USER_PER_HOUR + 1)]
    assert codes[-1] == 429


def test_voting_touches_only_feedback_tables(env, student, open_poll):
    """No rewards: a ballot never touches allowance, credits or any other table."""
    poll_id, qids = open_poll
    vote(client_for(student["id"]), poll_id, [(qids[0], "yes")], "hello")
    touched = {name for name, _op in env.db.calls}
    assert touched <= {"users", "feedback_polls", "feedback_questions", "feedback_responses", "feedback_answers", "feedback_submit"}


# ---------------------------------------------------------------- verified-account requirement


@pytest.mark.parametrize("verified", [False, None, "yes", "missing", "error"])
def test_unverified_or_unknown_accounts_get_403(env, open_poll, verified):
    poll_id, qids = open_poll
    if verified == "missing":
        uid = str(uuid.uuid4())
    else:
        uid = env.db.user(email="u@example.com", verified=None if verified == "error" else verified)["id"]
    if verified == "error":
        env.db.fail_on.add(("users", "select"))
    r = vote(client_for(uid), poll_id, [(qids[0], "yes")])
    assert r.status_code == 403
    assert r.json() == {"detail": "Verify your email to answer the poll.", "error_code": "email_unverified"}
    assert env.db.rows("feedback_responses") == []


def test_unverified_student_sees_the_poll_but_cannot_vote(env, open_poll):
    uid = env.db.user(email="new@example.com", verified=False)["id"]
    body = client_for(uid).get("/feedback/current").json()
    assert body["poll"] is not None and body["can_vote"] is False and body["blocked_reason"] == "email_unverified"


def test_database_rechecks_verification(env, student, open_poll):
    poll_id, qids = open_poll

    def unverify(name, params):
        student["email_verified"] = False
        env.db.tables["users"][0]["email_verified"] = False

    env.db.rpc_hook = unverify
    r = vote(client_for(student["id"]), poll_id, [(qids[0], "yes")])
    assert r.status_code == 403 and r.json()["error_code"] == "email_unverified"


# ---------------------------------------------------------------- exact deadlines


@pytest.mark.parametrize(
    "offset,expected,code",
    [
        (timedelta(seconds=-1), 409, "poll_not_open"),
        (timedelta(0), 201, None),
    ],
)
def test_opening_second(env, student, open_poll, offset, expected, code):
    poll_id, qids = open_poll
    env.clock["t"] = datetime(2026, 11, 29, 18, tzinfo=UTC) + offset
    r = vote(client_for(student["id"]), poll_id, [(qids[0], "yes")])
    assert r.status_code == expected
    if code:
        assert r.json()["error_code"] == code


@pytest.mark.parametrize(
    "offset,expected",
    [
        (timedelta(seconds=-1), 201),
        (timedelta(microseconds=-1), 201),
        (timedelta(0), 409),
        (timedelta(seconds=1), 409),
    ],
)
def test_closing_second(env, student, open_poll, offset, expected):
    poll_id, qids = open_poll
    env.clock["t"] = datetime(2026, 12, 6, 18, tzinfo=UTC) + offset
    r = vote(client_for(student["id"]), poll_id, [(qids[0], "yes")])
    assert r.status_code == expected
    if expected == 409:
        assert r.json()["error_code"] == "poll_closed"
        assert r.json()["detail"] == "This poll closed before your answers arrived."


def test_database_clock_wins_at_the_deadline(env, student, open_poll):
    poll_id, qids = open_poll

    def closed(name, params):
        raise FakeAPIError("P0001", "poll_closed")

    env.db.rpc_hook = closed
    r = vote(client_for(student["id"]), poll_id, [(qids[0], "yes")])
    assert r.status_code == 409 and r.json()["error_code"] == "poll_closed"


def test_unknown_or_draft_polls_are_404(env, student):
    draft_id, qids = seed_poll(env.db, NOW + timedelta(days=1), NOW + timedelta(days=8), approved=False)
    c = client_for(student["id"])
    assert vote(c, draft_id, [(qids[0], "yes")]).json()["error_code"] == "poll_not_found"
    assert vote(c, str(uuid.uuid4()), [(qids[0], "yes")]).status_code == 404
    assert vote(c, "not-a-uuid", [(qids[0], "yes")]).status_code == 404


def test_missing_function_is_503(env, student, open_poll):
    poll_id, qids = open_poll
    env.db.missing.add("feedback_submit")
    r = vote(client_for(student["id"]), poll_id, [(qids[0], "yes")])
    assert r.status_code == 503 and r.json()["error_code"] == "feedback_unavailable"


# ---------------------------------------------------------------- comments


def test_comment_length_limit_counts_characters(env, open_poll):
    poll_id, qids = open_poll
    users = [env.db.user(email=f"s{i}@example.com") for i in range(4)]
    assert vote(client_for(users[0]["id"]), poll_id, [], "a" * 500).status_code == 201
    too_long = vote(client_for(users[1]["id"]), poll_id, [], "b" * 501)
    assert too_long.status_code == 422 and too_long.json()["error_code"] == "comment_too_long"
    assert "bbbb" not in too_long.text
    assert vote(client_for(users[2]["id"]), poll_id, [], "\U0001F600" * 500).status_code == 201
    assert vote(client_for(users[3]["id"]), poll_id, [(qids[0], "yes")], "   ").status_code == 201
    assert env.db.rows("feedback_responses")[-1]["comment"] is None


def test_html_is_stored_as_plain_text_and_shown_only_to_admins(env, student, admin, open_poll):
    poll_id, qids = open_poll
    evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
    assert vote(client_for(student["id"]), poll_id, [(qids[0], "yes")], evil).status_code == 201
    assert env.db.rows("feedback_responses")[0]["comment"] == evil
    close_poll(env)
    comments = client_for(admin["id"]).get(f"/admin/feedback/polls/{poll_id}/comments")
    assert comments.headers["content-type"].startswith("application/json")
    assert comments.json()[0]["comment"] == evil


def test_invisible_and_control_characters_are_removed():
    raw = "Café​‮ bell\u0007\r\n\r\n\r\n\r\nend﻿"
    assert feedback_text.clean_comment(raw) == "Café bell\n\nend"


# ---------------------------------------------------------------- skip


def test_skip_is_remembered_and_is_not_a_vote(env, student, open_poll):
    poll_id, qids = open_poll
    c = client_for(student["id"])
    r = c.post(f"/feedback/polls/{poll_id}/skip")
    assert r.status_code == 200 and r.json()["status"] == "skipped"
    assert c.post(f"/feedback/polls/{poll_id}/skip").status_code == 200  # double tap
    assert len(env.db.rows("feedback_skips")) == 1
    body = c.get("/feedback/current").json()
    assert body["skipped"] is True and body["can_vote"] is True and body["my_response"] is None
    assert env.db.rows("feedback_responses") == []
    assert client_for(student["id"]).get("/feedback/current").json()["skipped"] is True
    # Changing your mind later is fine: skipping didn't use up the vote.
    assert vote(c, poll_id, [(qids[0], "yes")]).status_code == 201


def test_skip_rules(env, student):
    draft_id, _ = seed_poll(env.db, NOW + timedelta(days=1), NOW + timedelta(days=8), approved=False)
    closed_id, _ = seed_poll(env.db, NOW - timedelta(days=9), NOW - timedelta(days=2), month="2026-10-01")
    scheduled_id, _ = seed_poll(env.db, NOW + timedelta(days=20), NOW + timedelta(days=27), month="2026-12-01")
    c = client_for(student["id"])
    assert c.post(f"/feedback/polls/{draft_id}/skip").status_code == 404
    assert c.post(f"/feedback/polls/{closed_id}/skip").json()["error_code"] == "poll_closed"
    # A poll that hasn't opened yet never asked them, so it can't be skipped yet.
    early = c.post(f"/feedback/polls/{scheduled_id}/skip")
    assert early.status_code == 409 and early.json()["error_code"] == "poll_not_open"
    assert env.db.rows("feedback_skips") == []


def test_unverified_student_can_skip(env, open_poll):
    poll_id, _ = open_poll
    uid = env.db.user(email="new@example.com", verified=False)["id"]
    c = client_for(uid)
    assert c.post(f"/feedback/polls/{poll_id}/skip").json()["status"] == "skipped"
    assert c.get("/feedback/current").json()["skipped"] is True


# ---------------------------------------------------------------- public results


def fill_votes(env, poll_id, qids, ballots, comment_each=None):
    for i, answers in enumerate(ballots):
        u = env.db.user(email=f"voter{i}-{poll_id[:4]}@example.com")
        r = vote(client_for(u["id"]), poll_id, [(qids[j], c) for j, c in answers], comment_each)
        assert r.status_code == 201, r.text


def test_results_stay_private_until_the_deadline(env, student, open_poll):
    poll_id, qids = open_poll
    fill_votes(env, poll_id, qids, [[(0, "yes")], [(0, "no")]])
    c = client_for(student["id"])
    env.clock["t"] = datetime(2026, 12, 6, 17, 59, 59, tzinfo=UTC)
    early = c.get(f"/feedback/results/{poll_id}")
    assert early.status_code == 409 and early.json()["error_code"] == "results_not_ready"
    assert set(early.json()) == {"detail", "error_code", "closes_at"}
    assert c.get("/feedback/results").json() == []
    env.clock["t"] = datetime(2026, 12, 6, 18, tzinfo=UTC)
    assert c.get(f"/feedback/results/{poll_id}").status_code == 200
    assert [p["id"] for p in c.get("/feedback/results").json()] == [poll_id]


def test_student_results_are_percentages_only(env, student, open_poll):
    poll_id, qids = open_poll
    # q1: 4 yes 1 no (2 left blank); q2: 1 yes 0 no (too few to show); q3: nobody.
    fill_votes(env, poll_id, qids, [[(0, "yes")], [(0, "yes"), (1, "yes")], [(0, "yes")], [(0, "no")], [(0, "yes")], [], []],
               comment_each=SENTINEL)
    env.clock["t"] = datetime(2026, 12, 7, tzinfo=UTC)
    body = client_for(student["id"]).get(f"/feedback/results/{poll_id}").json()
    assert set(body) == {"poll", "questions", "updates", "update_summary"}
    rows = {q["id"]: q for q in body["questions"]}
    assert set(rows[qids[0]]) == {"id", "position", "label", "yes_pct", "no_pct"}
    assert (rows[qids[0]]["yes_pct"], rows[qids[0]]["no_pct"]) == (80, 20)
    # Fewer than 5 answers: no percentages, so 1 or 2 votes can't give anyone away.
    assert rows[qids[1]]["yes_pct"] is None and rows[qids[1]]["no_pct"] is None
    assert rows[qids[2]]["yes_pct"] is None and rows[qids[2]]["no_pct"] is None
    # Shown rows first (by Yes %), hidden rows last in question order (their place says nothing).
    assert [q["id"] for q in body["questions"]] == [qids[0], qids[1], qids[2]]
    assert body["update_summary"] == "We're reviewing your feedback." and body["updates"] == []
    text = json.dumps(body)
    assert SENTINEL not in text and "@" not in text
    for r in env.db.rows("feedback_responses"):
        assert r["id"] not in text and r["user_id"] not in text and r["voter_key"] not in text
    for banned in ("participants", "yes", "no", "answered", "skipped", "no_votes", "comment", "themes"):
        assert banned not in set(walk(body))


@pytest.mark.parametrize("answers,shown", [(4, False), (5, True)])
def test_student_percentages_need_five_answers(env, student, open_poll, answers, shown):
    poll_id, qids = open_poll
    fill_votes(env, poll_id, qids, [[(0, "yes")]] * answers)
    close_poll(env)
    row = [q for q in client_for(student["id"]).get(f"/feedback/results/{poll_id}").json()["questions"] if q["id"] == qids[0]][0]
    assert (row["yes_pct"], row["no_pct"]) == ((100, 0) if shown else (None, None))
    # Admins still see the exact counts.
    admin = env.db.user(email="boss@example.com", role="admin")
    totals = client_for(admin["id"]).get(f"/admin/feedback/polls/{poll_id}/totals").json()
    first = [q for q in totals["questions"] if q["id"] == qids[0]][0]
    assert (first["yes"], first["yes_pct"]) == (answers, 100)


def test_archive_keeps_the_last_24_closed_polls(env, student):
    ids = []
    for i in range(26):
        opens = NOW - timedelta(days=40 + 30 * i)
        pid, _ = seed_poll(env.db, opens, opens + timedelta(days=7), month=(opens.strftime("%Y-%m-01")))
        ids.append(pid)
    seed_poll(env.db, NOW + timedelta(days=3), NOW + timedelta(days=10), approved=False, month="2030-01-01")
    c = client_for(student["id"])
    archive = c.get("/feedback/results").json()
    assert [p["id"] for p in archive] == ids[:24]
    assert set(archive[0]) == {"id", "title", "period_month", "opens_at", "closes_at"}
    assert c.get(f"/feedback/results/{ids[23]}").status_code == 200
    assert c.get(f"/feedback/results/{ids[24]}").status_code == 404


def test_published_updates_only_after_close(env, student, admin, open_poll):
    poll_id, _ = open_poll
    a = client_for(admin["id"])
    assert a.post(f"/admin/feedback/polls/{poll_id}/updates", json={"title": "Dark mode", "status": "planned", "published": True}).status_code == 201
    assert a.post(f"/admin/feedback/polls/{poll_id}/updates", json={"title": "Secret draft", "status": "done"}).status_code == 201
    assert a.post(f"/admin/feedback/polls/{poll_id}/updates", json={"title": "x", "status": "shipped"}).status_code == 422
    c = client_for(student["id"])
    assert c.get(f"/feedback/results/{poll_id}").status_code == 409
    env.clock["t"] = datetime(2026, 12, 7, tzinfo=UTC)
    body = c.get(f"/feedback/results/{poll_id}").json()
    assert body["updates"] == [{"title": "Dark mode", "status": "planned", "note": None}]
    assert body["update_summary"] is None


# ---------------------------------------------------------------- admin permissions


ADMIN_ROUTES = sorted(
    {(route.path, method) for route in main.app.routes if getattr(route, "path", "").startswith("/admin/feedback")
     for method in getattr(route, "methods", ()) if method in ("GET", "POST", "PUT", "PATCH", "DELETE")}
)


def test_admin_routes_are_found():
    assert len(ADMIN_ROUTES) >= 15


@pytest.mark.parametrize("path,method", ADMIN_ROUTES)
def test_every_admin_route_needs_an_admin(env, student, path, method):
    url = path.replace("{poll_id}", str(uuid.uuid4())).replace("{theme_id}", str(uuid.uuid4()))
    url = url.replace("{response_id}", str(uuid.uuid4())).replace("{update_id}", str(uuid.uuid4()))
    main.app.dependency_overrides.pop(get_current_user_id, None)
    anonymous = TestClient(main.app).request(method, url, json={})
    assert anonymous.status_code == 401
    assert client_for(student["id"]).request(method, url, json={}).status_code == 403
    assert client_for(str(uuid.uuid4())).request(method, url, json={}).status_code == 403  # no users row
    env.db.fail_on.add(("users", "select"))
    assert client_for(student["id"]).request(method, url, json={}).status_code == 403  # read error
    env.db.fail_on.clear()


def test_demotion_takes_effect_on_the_next_request(env, admin):
    c = client_for(admin["id"])
    assert c.get("/admin/feedback/polls").status_code == 200
    admin["role"] = None
    env.db.tables["users"][0]["role"] = None
    assert c.get("/admin/feedback/polls").status_code == 403


# ---------------------------------------------------------------- admin: drafts, dates, questions, approval


def test_list_creates_monthly_drafts_once(env, admin):
    env.clock["t"] = datetime(2026, 12, 15, 12, tzinfo=UTC)
    c = client_for(admin["id"])
    first = c.get("/admin/feedback/polls").json()
    assert [p["period_month"] for p in first] == ["2027-01-01", "2026-12-01"]
    assert all(p["status"] == "draft" and p["approved_at"] is None for p in first)
    assert first[1]["opens_local"] == "2026-12-27T12:00" and first[1]["closes_local"] == "2027-01-03T12:00"
    assert first[0]["opens_at"] == "2027-01-31T18:00:00Z"
    c.get("/admin/feedback/polls")
    assert len(env.db.rows("feedback_polls")) == 2


def test_two_tabs_creating_drafts_at_once_make_one(env, admin):
    env.clock["t"] = datetime(2026, 11, 2, 12, tzinfo=UTC)
    original = env.db.before_insert

    def other_tab_won(table, row):
        if table == "feedback_polls" and not [p for p in env.db.rows("feedback_polls") if p["period_month"] == row["period_month"]]:
            env.db.rows("feedback_polls").append({**row, "id": str(uuid.uuid4())})
        original(table, row)

    env.db.before_insert = other_tab_won
    r = client_for(admin["id"]).get("/admin/feedback/polls")
    assert r.status_code == 200 and len(env.db.rows("feedback_polls")) == 2


def test_missed_draft_is_marked_and_can_be_moved(env, admin):
    env.clock["t"] = datetime(2026, 11, 30, 12, tzinfo=UTC)  # after Nov 29 noon
    c = client_for(admin["id"])
    polls = {p["period_month"]: p for p in c.get("/admin/feedback/polls").json()}
    nov = polls["2026-11-01"]
    assert nov["status"] == "missed"
    c.put(f"/admin/feedback/polls/{nov['id']}/questions", json={"questions": [{"label": "Add a dark mode"}]})
    checklist = {"checklist": {"one_change_each": True, "yes_means_change": True}}
    assert c.post(f"/admin/feedback/polls/{nov['id']}/approve", json=checklist).json()["error_code"] == "opens_in_past"
    moved = c.patch(f"/admin/feedback/polls/{nov['id']}", json={"opens_local": "2026-12-01T12:00", "closes_local": "2026-12-05T12:00"})
    assert moved.status_code == 200 and moved.json()["status"] == "draft"
    assert c.post(f"/admin/feedback/polls/{nov['id']}/approve", json=checklist).json()["status"] == "scheduled"


@pytest.mark.parametrize(
    "opens,closes,code",
    [
        ("2027-03-14T02:30", "2027-03-20T12:00", "nonexistent_local_time"),
        ("2026-11-01T01:30", "2026-11-05T12:00", "ambiguous_local_time"),
        ("2026-12-10T12:00", "2026-12-09T12:00", "bad_window"),
        ("2026-12-01T12:00", "2027-01-05T12:00", "bad_window"),
        ("tomorrow", "2026-12-09T12:00", "bad_local_time"),
        ("2026-12-01T12:00+05:00", "2026-12-09T12:00", "bad_local_time"),
    ],
)
def test_bad_dates(env, admin, opens, closes, code):
    pid, _ = seed_poll(env.db, NOW + timedelta(days=5), NOW + timedelta(days=12), approved=False, month="2027-05-01")
    r = client_for(admin["id"]).patch(f"/admin/feedback/polls/{pid}", json={"opens_local": opens, "closes_local": closes})
    assert r.status_code == 422 and r.json()["error_code"] == code


def test_wording_lock_and_date_rules(env, admin):
    c = client_for(admin["id"])
    pid, _ = seed_poll(env.db, NOW + timedelta(days=5), NOW + timedelta(days=12), labels=(), approved=False, month="2027-05-01")
    checklist = {"checklist": {"one_change_each": True, "yes_means_change": True}}
    assert c.post(f"/admin/feedback/polls/{pid}/approve", json=checklist).json()["error_code"] == "no_questions"
    saved = c.put(f"/admin/feedback/polls/{pid}/questions", json={"questions": [
        {"label": "  Add a dark   mode "}, {"label": "Don't change the colors"}, {"label": "Add quizzes and games"}]})
    assert saved.status_code == 200
    detail = saved.json()
    assert [q["label"] for q in detail["questions"]] == ["Add a dark mode", "Don't change the colors", "Add quizzes and games"]
    assert {(w["position"], w["message"]) for w in detail["lint"]} == {
        (2, feedback_text.LINT_NEGATIVE), (3, feedback_text.LINT_TWO_CHANGES)}
    assert c.put(f"/admin/feedback/polls/{pid}/questions", json={"questions": [{"label": "ok"}]}).json()["error_code"] == "bad_questions"
    assert c.put(f"/admin/feedback/polls/{pid}/questions", json={"questions": [{"label": "Same one"}, {"label": "same ONE"}]}).status_code == 422
    assert c.put(f"/admin/feedback/polls/{pid}/questions", json={"questions": [{"label": f"Change {i}"} for i in range(13)]}).status_code == 422
    assert c.post(f"/admin/feedback/polls/{pid}/approve", json={"checklist": {"one_change_each": True}}).json()["error_code"] == "checklist"
    approved = c.post(f"/admin/feedback/polls/{pid}/approve", json=checklist)
    assert approved.status_code == 200 and approved.json()["status"] == "scheduled"
    locked = c.put(f"/admin/feedback/polls/{pid}/questions", json={"questions": [{"label": "New wording"}]})
    assert locked.status_code == 409 and locked.json()["detail"] == "Move it back to draft to edit questions."
    moved = c.patch(f"/admin/feedback/polls/{pid}", json={"opens_local": "2026-12-10T12:00", "closes_local": "2026-12-15T12:00"})
    assert moved.status_code == 200 and moved.json()["status"] == "scheduled"
    assert c.patch(f"/admin/feedback/polls/{pid}", json={"opens_local": "2026-11-01T12:00", "closes_local": "2026-11-05T12:00"}).json()["error_code"] == "opens_in_past"
    assert c.post(f"/admin/feedback/polls/{pid}/unapprove").json()["status"] == "draft"
    assert c.post(f"/admin/feedback/polls/{pid}/approve", json=checklist).status_code == 200
    # Voting starts: everything locks.
    env.clock["t"] = datetime(2026, 12, 10, 18, tzinfo=UTC)
    started = c.put(f"/admin/feedback/polls/{pid}/questions", json={"questions": [{"label": "New wording"}]})
    assert started.status_code == 409 and started.json()["detail"] == "Voting has started, so the wording is locked."
    assert c.patch(f"/admin/feedback/polls/{pid}", json={"opens_local": "2026-12-20T12:00", "closes_local": "2026-12-25T12:00"}).json()["error_code"] == "wording_locked"
    assert c.post(f"/admin/feedback/polls/{pid}/unapprove").json()["error_code"] == "wording_locked"


def test_overlapping_approved_polls_are_refused(env, admin, open_poll):
    c = client_for(admin["id"])
    pid, _ = seed_poll(env.db, NOW + timedelta(days=2), NOW + timedelta(days=9), approved=False, month="2027-06-01")
    r = c.post(f"/admin/feedback/polls/{pid}/approve", json={"checklist": {"one_change_each": True, "yes_means_change": True}})
    assert r.status_code == 409 and r.json()["error_code"] == "overlap"


def test_admin_totals_show_counts(env, admin, open_poll):
    poll_id, qids = open_poll
    c = client_for(admin["id"])
    empty = c.get(f"/admin/feedback/polls/{poll_id}/totals").json()
    assert empty["participants"] == 0 and empty["no_votes"] is True
    fill_votes(env, poll_id, qids, [[(0, "yes")], [(0, "yes"), (1, "no")], [(0, "no")]])
    c = client_for(admin["id"])
    # While the poll is open: only how many answered, never per-question counts.
    live = c.get(f"/admin/feedback/polls/{poll_id}/totals").json()
    assert live["participants"] == 3 and live["final"] is False and live["questions"] == []
    close_poll(env)
    body = c.get(f"/admin/feedback/polls/{poll_id}/totals").json()
    assert body["participants"] == 3 and body["no_votes"] is False and body["final"] is True
    first = body["questions"][0]
    assert (first["id"], first["yes"], first["no"], first["answered"], first["skipped"], first["yes_pct"]) == (qids[0], 2, 1, 3, 0, 67)
    assert body["questions"][-1]["yes_pct"] is None
    future, _ = seed_poll(env.db, NOW + timedelta(days=20), NOW + timedelta(days=27), month="2027-07-01")
    assert c.get(f"/admin/feedback/polls/{future}/totals").json()["error_code"] == "not_open_yet"
    listed = {p["id"]: p for p in c.get("/admin/feedback/polls").json()}
    assert listed[poll_id]["participants"] == 3 and listed[poll_id]["question_count"] == 3


# ---------------------------------------------------------------- admin: comments, themes, flags


def comment_poll(env, open_poll, texts, close=True):
    poll_id, qids = open_poll
    for i, text in enumerate(texts):
        u = env.db.user(email=f"c{i}@example.com", user_id=str(uuid.uuid4()))
        assert vote(client_for(u["id"]), poll_id, [(qids[0], "yes")], text).status_code == 201
    if close:
        close_poll(env)
    return poll_id


def test_open_poll_hides_comments_and_counts_from_admins(env, admin, open_poll):
    """While voting is open an admin could watch a known student vote and see the change."""
    poll_id = comment_poll(env, open_poll, ["Please add a dark mode", "my account got hacked"], close=False)
    c = client_for(admin["id"])
    for method, path in (("GET", "comments"), ("GET", "themes"), ("POST", "themes/regroup")):
        r = c.request(method, f"/admin/feedback/polls/{poll_id}/{path}")
        assert r.status_code == 409 and r.json()["error_code"] == "after_close", path
        assert "dark mode" not in r.text
    rid = env.db.rows("feedback_responses")[0]["id"]
    assert c.patch(f"/admin/feedback/responses/{rid}", json={"urgent_flags": []}).json()["error_code"] == "after_close"
    assert c.post("/admin/feedback/themes/merge", json={"poll_id": poll_id, "into_theme_id": str(uuid.uuid4()),
                                                        "from_theme_ids": [str(uuid.uuid4())]}).json()["error_code"] == "after_close"
    totals = c.get(f"/admin/feedback/polls/{poll_id}/totals").json()
    assert totals["participants"] == 2 and totals["questions"] == [] and totals["final"] is False
    close_poll(env)
    assert len(c.get(f"/admin/feedback/polls/{poll_id}/comments").json()) == 2


def test_admin_comments_are_in_response_id_order_not_newest_first(env, admin, open_poll):
    poll_id, qids = open_poll
    for i in range(6):
        env.clock["t"] = NOW + timedelta(minutes=i)
        u = env.db.user(email=f"order{i}@example.com", user_id=str(uuid.uuid4()))
        assert vote(client_for(u["id"]), poll_id, [(qids[0], "yes")], f"comment number {i}").status_code == 201
    close_poll(env)
    comments = client_for(admin["id"]).get(f"/admin/feedback/polls/{poll_id}/comments").json()
    assert [x["response_id"] for x in comments] == sorted(x["response_id"] for x in comments)


def test_admins_see_comment_text_never_the_writer(env, admin, open_poll):
    poll_id = comment_poll(env, open_poll, ["Please add a dark mode", "my account got hacked", SENTINEL])
    c = client_for(admin["id"])
    comments = c.get(f"/admin/feedback/polls/{poll_id}/comments").json()
    assert {x["comment"] for x in comments} == {"Please add a dark mode", "my account got hacked", SENTINEL}
    for item in comments:
        assert set(item) == {"response_id", "response_ref", "comment", "urgent_flags", "urgent_set_by_admin", "theme_ids"}
        assert len(item["response_ref"]) == 8
    everything = []
    for path in ("comments", "themes", "totals"):
        everything.append(c.get(f"/admin/feedback/polls/{poll_id}/{path}").json())
    everything.append(c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").json())
    everything.append(c.get("/admin/feedback/polls").json())
    everything.append(c.get(f"/admin/feedback/polls/{poll_id}").json())
    text = json.dumps(everything)
    keys = set(walk(everything))
    for banned in ("user_id", "email", "username", "voter_key", "submitted_at"):
        assert banned not in keys
    for user in env.db.rows("users"):
        assert user["id"] not in text and user["email"] not in text
    for r in env.db.rows("feedback_responses"):
        assert r["voter_key"] not in text
    urgent = c.get(f"/admin/feedback/polls/{poll_id}/comments?urgent=true").json()
    assert [x["comment"] for x in urgent] == ["my account got hacked"] and urgent[0]["urgent_flags"] == ["security"]


def test_themes_group_distinct_people_and_keep_urgent_first(env, admin, open_poll):
    texts = ["dark mode please", "Please add a dark mode!!", "night mode", "dark mode dark mode dark mode",
             "screen reader can't read the cards", "make quizzes", "other people can see my notes"]
    poll_id = comment_poll(env, open_poll, texts)
    c = client_for(admin["id"])
    body = c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").json()
    top = body["themes"][0]
    assert top["label"].lower() == "dark mode" and top["count"] == 4 and top["source"] == "auto"
    assert [u["comment"] for u in body["urgent"]] == ["other people can see my notes", "screen reader can't read the cards"] or \
        {u["comment"] for u in body["urgent"]} == {"other people can see my notes", "screen reader can't read the cards"}
    flags = {u["comment"]: u["urgent_flags"] for u in body["urgent"]}
    assert flags["screen reader can't read the cards"] == ["accessibility"]
    assert flags["other people can see my notes"] == ["privacy"]
    assert body["other_count"] >= 2
    again = c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").json()
    strip = lambda b: [(t["label"], t["count"], t["source"]) for t in b["themes"]]  # noqa: E731
    assert strip(again) == strip(body)
    by_theme = c.get(f"/admin/feedback/polls/{poll_id}/comments?theme_id={top['id']}").json()
    assert by_theme == [] or all(top["id"] in x["theme_ids"] for x in by_theme)


def test_merge_split_rename_delete_and_regroup_keeps_admin_work(env, admin, open_poll):
    texts = ["dark mode please", "add dark mode", "dark mode at night", "faster quizzes", "quizzes faster please",
             "quizzes and dark mode"]
    poll_id = comment_poll(env, open_poll, texts)
    c = client_for(admin["id"])
    body = c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").json()
    themes = {t["label"].lower(): t for t in body["themes"]}
    dark, quiz = themes["dark mode"], [t for k, t in themes.items() if "quiz" in k][0]
    overlap = set(dark["response_ids"]) & set(quiz["response_ids"])
    merged = c.post("/admin/feedback/themes/merge", json={"poll_id": poll_id, "into_theme_id": dark["id"], "from_theme_ids": [quiz["id"]]})
    assert merged.status_code == 200
    target = [t for t in merged.json()["themes"] if t["id"] == dark["id"]][0]
    assert target["count"] == len(set(dark["response_ids"]) | set(quiz["response_ids"]))
    assert len(overlap) == 1 and target["count"] == len(dark["response_ids"]) + len(quiz["response_ids"]) - 1
    assert target["source"] == "admin"
    retry = c.post("/admin/feedback/themes/merge", json={"poll_id": poll_id, "into_theme_id": dark["id"], "from_theme_ids": [quiz["id"]]})
    assert retry.status_code == 200
    move = sorted(set(quiz["response_ids"]) - set(dark["response_ids"]))
    split = c.post(f"/admin/feedback/themes/{dark['id']}/split", json={"label": "Quizzes", "response_ids": move})
    assert split.status_code == 200
    new = [t for t in split.json()["themes"] if t["label"] == "Quizzes"][0]
    assert new["source"] == "admin" and sorted(new["response_ids"]) == move
    bad = c.post(f"/admin/feedback/themes/{dark['id']}/split", json={"label": "X", "response_ids": [str(uuid.uuid4())]})
    assert bad.status_code == 422
    assert c.patch(f"/admin/feedback/themes/{dark['id']}", json={"label": "Night look"}).status_code == 200
    after = c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").json()
    labels = [t["label"] for t in after["themes"]]
    assert {"Night look", "Quizzes"} <= set(labels)
    assert len(labels) == len({label.casefold() for label in labels}), labels  # no duplicate themes
    terms = [t.get("term") for t in env.db.rows("feedback_comment_themes") if t.get("term")]
    assert len(terms) == len(set(terms)), terms
    assert c.delete(f"/admin/feedback/themes/{new['id']}").status_code == 200
    assert "Quizzes" not in {t["label"] for t in c.get(f"/admin/feedback/polls/{poll_id}/themes").json()["themes"]}


def test_regroup_after_merge_does_not_bring_merged_themes_back(env, admin, open_poll):
    texts = ["dark mode please", "add dark mode", "dark mode at night", "faster quizzes", "quizzes faster please",
             "quizzes and dark mode"]
    poll_id = comment_poll(env, open_poll, texts)
    c = client_for(admin["id"])
    body = c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").json()
    themes = {t["label"].lower(): t for t in body["themes"]}
    assert "quizzes" in themes  # the student's own word, not the stem "quizz"
    dark, quiz = themes["dark mode"], themes["quizzes"]
    c.post("/admin/feedback/themes/merge", json={"poll_id": poll_id, "into_theme_id": dark["id"], "from_theme_ids": [quiz["id"]]})
    for _ in range(2):
        after = c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").json()
        assert [(t["label"], t["count"], t["source"]) for t in after["themes"]] == [("Dark mode", 6, "admin")]
        assert after["other_count"] == 0
    # Renaming keeps the term: regroup never makes a second "Dark mode".
    c.patch(f"/admin/feedback/themes/{dark['id']}", json={"label": "Night look"})
    after = c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").json()
    assert [(t["label"], t["count"]) for t in after["themes"]] == [("Night look", 6)]


def test_admin_flag_changes_survive_regroup(env, admin, open_poll):
    poll_id = comment_poll(env, open_poll, ["my password leaked", "add dark mode", "dark mode please"])
    c = client_for(admin["id"])
    rid = [x for x in c.get(f"/admin/feedback/polls/{poll_id}/comments").json() if "password" in x["comment"]][0]["response_id"]
    cleared = c.patch(f"/admin/feedback/responses/{rid}", json={"urgent_flags": []})
    assert cleared.status_code == 200 and cleared.json()["urgent_flags"] == [] and cleared.json()["urgent_set_by_admin"] is True
    c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup")
    assert c.get(f"/admin/feedback/polls/{poll_id}/themes").json()["urgent"] == []
    assert c.patch(f"/admin/feedback/responses/{rid}", json={"urgent_flags": ["nope"]}).status_code == 422
    other = [x for x in c.get(f"/admin/feedback/polls/{poll_id}/comments").json() if "password" not in x["comment"]][0]
    flagged = c.patch(f"/admin/feedback/responses/{other['response_id']}", json={"urgent_flags": ["privacy", "security"]})
    assert flagged.json()["urgent_flags"] == ["security", "privacy"]


def test_admin_updates_crud(env, admin, open_poll):
    poll_id, _ = open_poll
    c = client_for(admin["id"])
    created = c.post(f"/admin/feedback/polls/{poll_id}/updates", json={"title": "Dark mode", "note": "Coming soon"}).json()
    assert created["status"] == "reviewing" and created["published"] is False and created["position"] == 1
    patched = c.patch(f"/admin/feedback/updates/{created['id']}", json={"status": "keeping", "published": True})
    assert patched.json()["status"] == "keeping" and patched.json()["published"] is True
    assert c.patch(f"/admin/feedback/updates/{created['id']}", json={"status": "maybe"}).status_code == 422
    assert [u["id"] for u in c.get(f"/admin/feedback/polls/{poll_id}/updates").json()] == [created["id"]]
    assert c.delete(f"/admin/feedback/updates/{created['id']}").json() == {"deleted": True}
    assert c.delete(f"/admin/feedback/updates/{created['id']}").status_code == 404


# ---------------------------------------------------------------- account deletion


def test_deletion_keeps_answers_and_deletes_comments(env, admin, open_poll):
    poll_id, qids = open_poll
    gone = env.db.user(email="leaving@example.com")
    stays = env.db.user(email="staying@example.com")
    assert client_for(gone["id"]).post(f"/feedback/polls/{poll_id}/skip").json()["status"] == "skipped"
    vote(client_for(gone["id"]), poll_id, [(qids[0], "yes"), (qids[1], "no")], f"dark mode please {SENTINEL}")
    vote(client_for(stays["id"]), poll_id, [(qids[0], "yes")], "dark mode now")
    ballot_id = [r for r in env.db.rows("feedback_responses") if r["user_id"] == gone["id"]][0]["id"]
    close_poll(env)
    c = client_for(admin["id"])
    c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup")
    before = c.get(f"/admin/feedback/polls/{poll_id}/totals").json()

    deps = ad.DeletionDeps(db=env.db)
    result = ad.step_anonymize_feedback(gone["id"], deps)
    assert result.outcome == ad.ANONYMIZED and result.count == 1
    ballot = [r for r in env.db.rows("feedback_responses") if r["id"] == ballot_id][0]
    assert ballot["user_id"] is None and ballot["comment"] is None and ballot["urgent_flags"] == []
    # The poll has closed, so the email key goes too: a known email can't find these answers.
    assert ballot["voter_key"] is None
    assert not [r for r in env.db.rows("feedback_responses") if r["voter_key"] == feedback.voter_key("leaving@example.com")]
    staying = [r for r in env.db.rows("feedback_responses") if r["user_id"] == stays["id"]][0]
    assert staying["voter_key"] == feedback.voter_key("staying@example.com")
    assert not [m for m in env.db.rows("feedback_theme_members") if m["response_id"] == ballot["id"]]
    assert len([a for a in env.db.rows("feedback_answers") if a["response_id"] == ballot["id"]]) == 2
    assert c.get(f"/admin/feedback/polls/{poll_id}/totals").json()["questions"] == before["questions"]
    assert SENTINEL not in json.dumps(c.get(f"/admin/feedback/polls/{poll_id}/comments").json())
    skips = ad.step_delete_rows(gone["id"], deps, "feedback_skips")
    assert skips.outcome == ad.DELETED and env.db.rows("feedback_skips") == []
    again = ad.step_anonymize_feedback(gone["id"], deps)
    assert again.outcome == ad.NOTHING_FOUND


def test_open_poll_keeps_the_email_key_until_it_closes(env, student, admin, open_poll):
    poll_id, qids = open_poll
    assert vote(client_for(student["id"]), poll_id, [(qids[0], "yes")]).status_code == 201
    ad.step_anonymize_feedback(student["id"], ad.DeletionDeps(db=env.db))
    ballot = env.db.rows("feedback_responses")[0]
    key = feedback.voter_key(student["email"])
    assert ballot["user_id"] is None and ballot["voter_key"] == key  # still stops a second vote
    # The database refuses to forget it early.
    with pytest.raises(FakeAPIError, match="voter_key_in_use"):
        env.db.table("feedback_responses").update({"voter_key": None}).eq("id", ballot["id"]).execute()
    close_poll(env)
    # The next page load after close clears it (lazily, at most every few minutes).
    other = env.db.user(email="someone@example.com")
    assert client_for(other["id"]).get("/feedback/current").status_code == 200
    assert ballot["voter_key"] is None
    assert len([a for a in env.db.rows("feedback_answers") if a["response_id"] == ballot["id"]]) == 1


def test_voter_key_cleanup_runs_from_the_admin_list_and_is_throttled(env, admin, open_poll):
    poll_id, qids = open_poll
    gone = env.db.user(email="gone@example.com")
    vote(client_for(gone["id"]), poll_id, [(qids[0], "yes")])
    ad.step_anonymize_feedback(gone["id"], ad.DeletionDeps(db=env.db))
    c = client_for(admin["id"])
    c.get("/admin/feedback/polls")  # still open: nothing to clear, but it ran
    close_poll(env)
    c.get("/admin/feedback/polls")  # a week later: the cleanup runs again and clears it
    assert env.db.rows("feedback_responses")[0]["voter_key"] is None
    calls = [n for n, op in env.db.calls if n == "feedback_forget_voter_keys"]
    c.get("/admin/feedback/polls")
    assert [n for n, op in env.db.calls if n == "feedback_forget_voter_keys"] == calls  # throttled


def test_voter_key_uses_its_own_secret_when_set(env, monkeypatch):
    jwt_based = feedback.voter_key("Sam@Example.com")
    monkeypatch.setenv(feedback.VOTER_KEY_SECRET_ENV, "made-up-feedback-secret-for-tests")
    own = feedback.voter_key("sam@example.com")
    assert own and own != jwt_based and len(own) == 64
    monkeypatch.setenv(feedback.VOTER_KEY_SECRET_ENV, "   ")
    assert feedback.voter_key("sam@example.com") == jwt_based  # blank falls back to the JWT secret


def test_unverified_signup_cannot_see_whether_an_email_voted(env, student, open_poll):
    poll_id, qids = open_poll
    assert vote(client_for(student["id"]), poll_id, [(qids[0], "yes")]).status_code == 201
    ad.step_anonymize_feedback(student["id"], ad.DeletionDeps(db=env.db))
    env.db.tables["users"] = [u for u in env.db.rows("users") if u["id"] != student["id"]]
    impostor = env.db.user(email=student["email"], verified=False)
    body = client_for(impostor["id"]).get("/feedback/current").json()
    assert body["my_response"] is None and body["blocked_reason"] == "email_unverified"


def test_deletion_step_handles_missing_tables_and_failures(env):
    env.db.missing.add("feedback_responses")
    assert ad.step_anonymize_feedback("u1", ad.DeletionDeps(db=env.db)).outcome == ad.NOTHING_FOUND
    assert "feedback_skips" in ad.CHILD_TABLES


def test_deletion_plan_runs_the_feedback_step(env, monkeypatch):
    seen = []
    monkeypatch.setattr(ad, "step_anonymize_feedback", lambda uid, deps: seen.append(uid) or ad.StepResult("feedback_responses_anonymize", ad.NOTHING_FOUND))
    for name in ("step_cancel_stripe", "step_delete_legacy_subscriptions", "step_remove_storage", "step_anonymize_actor",
                 "step_delete_pending_signups", "step_anonymize_reports", "step_delete_rows", "step_delete_user_row"):
        monkeypatch.setattr(ad, name, lambda *a, n=name: ad.StepResult(n, ad.NOTHING_FOUND))
    report = ad.delete_account_data("user-1", ad.DeletionDeps(db=env.db))
    assert report.succeeded and seen == ["user-1"]


def test_kept_records_line_is_exact():
    assert ad.RETAINED_FEEDBACK == (
        "Your answers to monthly feedback polls stay in the totals, without your name. Your poll comments are deleted."
    )
    assert ad.RETAINED_FEEDBACK in ad.DeletionReport().retained


# ---------------------------------------------------------------- never sent anywhere external


FEEDBACK_MODULES = ["feedback.py", "feedback_themes.py", "feedback_text.py", "feedback_math.py", "feedback_schedule.py"]
BANNED_IMPORTS = {"openai", "httpx", "requests", "urllib", "urllib3", "deepgram", "analytics", "stripe", "socket", "aiohttp"}


@pytest.mark.parametrize("name", FEEDBACK_MODULES)
def test_feedback_modules_import_no_network_or_ai_clients(name):
    tree = ast.parse((Path(feedback.__file__).parent / name).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            mods = [node.module or ""] + [a.name for a in node.names]
        else:
            continue
        for mod in mods:
            assert mod.split(".")[0].lstrip(".") not in BANNED_IMPORTS, (name, mod)


def test_flows_work_with_the_network_switched_off(env, admin, open_poll, monkeypatch, caplog):
    def no_network(*_a, **_k):
        raise AssertionError("network used")

    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(socket, "getaddrinfo", no_network)
    caplog.set_level(logging.DEBUG)
    poll_id, qids = open_poll
    writer = env.db.user(email="writer@example.com")
    assert vote(client_for(writer["id"]), poll_id, [(qids[0], "yes")], f"dark mode {SENTINEL}").status_code == 201
    close_poll(env)
    c = client_for(admin["id"])
    assert c.post(f"/admin/feedback/polls/{poll_id}/themes/regroup").status_code == 200
    assert c.get(f"/admin/feedback/polls/{poll_id}/comments").status_code == 200
    assert c.get(f"/admin/feedback/polls/{poll_id}/totals").status_code == 200
    ad.step_anonymize_feedback(writer["id"], ad.DeletionDeps(db=env.db))
    logs = "\n".join(r.getMessage() for r in caplog.records)
    for leak in (SENTINEL, writer["id"], "writer@example.com", str(feedback.voter_key("writer@example.com"))):
        assert leak not in logs


# ---------------------------------------------------------------- the fake matches the migration


def test_fake_functions_match_the_migration():
    from tests.feedback_fake import RPC_SIGNATURES
    import re

    sql = (Path(feedback.__file__).parent / "schemas" / "migrations" / "2026_11_18_monthly_feedback.sql").read_text(encoding="utf-8")
    for name, params in RPC_SIGNATURES.items():
        match = re.search(rf"create or replace function public\.{name}\((.*?)\)\s*returns", sql, flags=re.S)
        assert match, name
        declared = [part.strip().split()[0] for part in match.group(1).split(",") if part.strip()]
        assert declared == params, (name, declared)
    for name in re.findall(r'\.rpc\("(\w+)"', (Path(feedback.__file__)).read_text(encoding="utf-8")):
        assert name in RPC_SIGNATURES
