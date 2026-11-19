"""The monthly feedback poll follows the maintenance break like every other write.

Ballots, skips and admin edits are ordinary writes: let through before the grace time ends,
refused after it and during the break. Reads that also tidy up (monthly drafts, voter-key
cleanup) write nothing once writes are refused. Account deletion keeps both its feedback step
and its place as long work that the break refuses.

Fake databases only (tests/maintenance_fakes.py, tests/feedback_fake.py). Synthetic data only.
"""

from __future__ import annotations

import re

import pytest
from fastapi.routing import APIRoute

from app import auth, maintenance, main
from tests.maintenance_fakes import gate_app, world  # noqa: F401
from tests.test_feedback_api import client_for, env, open_poll, seed_poll, vote  # noqa: F401

OTHER_WRITE = ("PUT", "/me/username")
POLL_WRITES = [
    ("POST", "/feedback/polls/x1/responses"),
    ("POST", "/feedback/polls/x1/skip"),
    ("PATCH", "/admin/feedback/polls/x1"),
    ("PUT", "/admin/feedback/polls/x1/questions"),
    ("POST", "/admin/feedback/polls/x1/approve"),
    ("POST", "/admin/feedback/polls/x1/unapprove"),
    ("POST", "/admin/feedback/polls/x1/themes/regroup"),
    ("POST", "/admin/feedback/themes/merge"),
    ("POST", "/admin/feedback/themes/x1/split"),
    ("PATCH", "/admin/feedback/themes/x1"),
    ("DELETE", "/admin/feedback/themes/x1"),
    ("PATCH", "/admin/feedback/responses/x1"),
    ("POST", "/admin/feedback/polls/x1/updates"),
    ("PATCH", "/admin/feedback/updates/x1"),
    ("DELETE", "/admin/feedback/updates/x1"),
]


def feedback_routes():
    for route in main.app.routes:
        if isinstance(route, APIRoute) and (route.path.startswith("/feedback") or route.path.startswith("/admin/feedback")):
            path = re.sub(r"\{[^}]+\}", "x1", route.path)
            for method in route.methods:
                yield method, path


def test_every_poll_route_is_in_a_gated_group():
    routes = list(feedback_routes())
    writes = {(m, p) for m, p in routes if m not in ("GET", "HEAD")}
    assert writes == set(POLL_WRITES), sorted(writes ^ set(POLL_WRITES))
    for method, path in routes:
        expected = maintenance.READ if method in ("GET", "HEAD") else maintenance.OTHER_WRITE
        assert maintenance.classify(method, path) == (expected, None), (method, path)


def outcome(client, method, path):
    response = client.request(method, path)
    if response.status_code == 503:
        return response.json()["error_code"]
    assert response.status_code == 200, response.text
    return "ok"


def test_poll_writes_are_refused_exactly_like_other_writes(world):
    gate, _ = gate_app(world)

    def same_as_other_writes(expected):
        assert outcome(gate, *OTHER_WRITE) == expected
        for method, path in POLL_WRITES:
            assert outcome(gate, method, path) == expected, (method, path)

    same_as_other_writes("ok")  # no break
    world.schedule()
    same_as_other_writes("ok")  # announced
    world.drain(grace_minutes=5)
    same_as_other_writes("ok")  # draining, inside the grace time
    world.clock.advance(minutes=5, seconds=1)
    same_as_other_writes("maintenance_draining")  # grace over
    assert world.activate().status_code == 200
    same_as_other_writes("maintenance_active")
    assert world.checks().status_code == 200
    same_as_other_writes("maintenance_active")  # checking


def use_feedback_db(monkeypatch, env):
    """After the admin steps (which read the maintenance fake), routes read the feedback fake."""
    monkeypatch.setattr(auth, "get_supabase", lambda: env.db)


def writes_to_feedback(env):
    return [c for c in env.db.calls if c[1] != "select"]


@pytest.mark.parametrize("phase", ["draining", "active"])
def test_ballots_skips_and_admin_edits_never_reach_the_database_during_a_break(env, world, monkeypatch, open_poll, phase):
    poll_id, qids = open_poll
    world.to_draining()
    world.clock.advance(minutes=6)
    if phase == "active":
        assert world.activate().status_code == 200
    use_feedback_db(monkeypatch, env)
    student = env.db.user(email="synth.student@example.test", verified=True)
    admin = env.db.user(email="synth.admin@example.test", verified=True, role="admin")
    code = f"maintenance_{phase}"

    voted = vote(client_for(student["id"]), poll_id, [(qids[0], "yes")], comment="SYNTH comment")
    skipped = client_for(student["id"]).post(f"/feedback/polls/{poll_id}/skip")
    edited = client_for(admin["id"]).put(f"/admin/feedback/polls/{poll_id}/questions", json={"questions": [{"label": "SYNTH"}]})
    for response in (voted, skipped, edited):
        assert response.status_code == 503 and response.json()["error_code"] == code, response.text
    assert env.db.calls == []  # refused before any route code ran
    assert env.db.rows("feedback_responses") == [] and env.db.rows("feedback_skips") == []


def test_reads_that_tidy_up_write_nothing_after_the_grace_time(env, world, monkeypatch):
    world.to_draining()
    world.clock.advance(minutes=6)  # reads still pass; writes are refused
    use_feedback_db(monkeypatch, env)
    student = env.db.user(email="synth.student@example.test", verified=True)
    admin = env.db.user(email="synth.admin@example.test", verified=True, role="admin")

    assert client_for(student["id"]).get("/feedback/current").status_code == 200
    listed = client_for(admin["id"]).get("/admin/feedback/polls")
    assert listed.status_code == 200 and listed.json() == []
    assert writes_to_feedback(env) == []  # no drafts made, no voter keys cleared
    assert env.db.rows("feedback_polls") == []


def test_reads_tidy_up_again_once_writes_are_allowed(env, world, monkeypatch):
    assert world.db.state["phase"] == "none"
    use_feedback_db(monkeypatch, env)
    admin = env.db.user(email="synth.admin@example.test", verified=True, role="admin")
    listed = client_for(admin["id"]).get("/admin/feedback/polls")
    assert listed.status_code == 200
    assert len(env.db.rows("feedback_polls")) == 2  # this month's and next month's drafts
    assert ("feedback_forget_voter_keys", "rpc") in env.db.calls


def test_a_process_that_has_not_read_the_break_state_writes_nothing_from_reads():
    runtime = maintenance.MaintenanceRuntime(store=maintenance.MaintenanceStore(configured=lambda: True))
    assert runtime.state_known is False  # a new process before its first read
    maintenance.set_runtime(runtime)
    try:
        assert maintenance.ordinary_writes_allowed() is False
        assert maintenance.writes_paused() is True
    finally:
        maintenance.set_runtime(None)


def test_account_deletion_waits_for_the_break_and_leaves_poll_answers_alone(env, world, monkeypatch, open_poll):
    # Deleting an account is long work: refused from the moment the drain starts, so its
    # feedback step (tests/test_feedback_api.py) never runs half way into a break.
    assert maintenance.classify("DELETE", "/me/account") == (maintenance.LONG, ("account_deletion", 300))
    world.to_draining()
    use_feedback_db(monkeypatch, env)
    poll_id, qids = open_poll
    student = env.db.user(email="synth.leaver@example.test", verified=True)
    assert vote(client_for(student["id"]), poll_id, [(qids[0], "yes")], comment="SYNTH stays").status_code == 201
    before = [dict(r) for r in env.db.rows("feedback_responses")]
    refused = client_for(student["id"]).request("DELETE", "/me/account", json={"current_password": "x"})
    assert refused.status_code == 503 and refused.json()["error_code"] == "maintenance_draining"
    assert env.db.rows("feedback_responses") == before
