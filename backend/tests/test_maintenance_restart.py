"""Two server instances sharing one maintenance state, and a server restart (fake database).

- Two simulated instances (two MaintenanceRuntime objects, one shared database) follow the
  same phase. Each refreshes its cached copy lazily, only when a request arrives after the
  cache expired.
- A restart (a new runtime with a new instance id) reloads the phase from the database, joins
  with its own instance row, and starts no timer or thread of its own.
- If the state can't be read, the last known phase is kept.
"""

import threading

from app import maintenance
from tests.maintenance_fakes import FakeClock, FakeMaintenanceDB, gate_app, make_runtime, world  # noqa: F401


def maintenance_threads():
    return [t for t in threading.enumerate() if t.name.startswith("maintenance-db")]


def test_two_instances_follow_the_same_phase(world):
    gate, _ = gate_app(world)
    instance_a = world.rt
    instance_b = make_runtime(world.db, world.clock, "instance-b")

    # B serves a request first and caches "none".
    maintenance.set_runtime(instance_b)
    assert gate.post("/api/transcribe").status_code == 200

    # The admin drains through A. A's own cache changes right away.
    maintenance.set_runtime(instance_a)
    world.to_draining()
    assert gate.post("/api/transcribe").status_code == 503

    # B still has its 5-second copy...
    maintenance.set_runtime(instance_b)
    assert gate.post("/api/transcribe").status_code == 200
    # ...and picks up the change on the first request after it expires.
    world.clock.advance(seconds=6)
    response = gate.post("/api/transcribe")
    assert response.status_code == 503 and response.json()["error_code"] == "maintenance_draining"
    assert response.headers["x-luma-maintenance-rev"] == str(world.rev())


def test_in_flight_work_on_instance_b_blocks_activation_from_instance_a(world):
    instance_a = world.rt
    world.to_draining()
    instance_b = make_runtime(world.db, world.clock, "instance-b")
    maintenance.set_runtime(instance_b)
    gate, _ = gate_app(world)
    gate.get("/notes")  # B reads the state (draining) and reports itself
    instance_b.wait_for_reports()

    instance_b.request_started()  # a save is still running on B
    instance_b.wait_for_reports()
    row_b = next(r for r in world.db.tables[maintenance.INSTANCES_TABLE] if r["instance_id"] == "instance-b")
    assert row_b["in_flight"] == 1 and row_b["phase_seen"] == "draining"

    maintenance.set_runtime(instance_a)
    world.clock.advance(minutes=6)
    # B's heartbeat is 6 minutes old now, with work in flight: it went quiet mid-work.
    refused = world.activate()
    assert refused.status_code == 409
    assert [r["code"] for r in refused.json()["reasons"]] == ["instance_silent"]

    instance_b.request_started()  # B is busy and reports again (fresh heartbeat)
    instance_b.wait_for_reports()
    refused = world.activate()
    assert [r["code"] for r in refused.json()["reasons"]] == ["requests_in_flight"]
    assert refused.json()["reasons"][0]["count"] == 2

    instance_b.request_finished()
    instance_b.request_finished()  # dropping to 0 is always reported
    instance_b.wait_for_reports()
    assert world.activate().status_code == 200
    assert world.db.state["phase"] == "active"


def test_restart_reloads_the_phase_and_joins_as_a_new_instance(world):
    gate, _ = gate_app(world)
    world.to_active()
    rev = world.rev()
    before = maintenance_threads()

    # The process restarts: a new runtime, a new instance id, nothing cached.
    restarted = make_runtime(world.db, world.clock, "instance-a-restarted")
    maintenance.set_runtime(restarted)
    world.rt = restarted
    assert restarted.state["phase"] == "none" and restarted.state["rev"] == 0  # never read yet
    response = gate.get("/notes")
    assert response.status_code == 503 and response.json()["error_code"] == "maintenance_active"
    assert restarted.state["phase"] == "active" and restarted.state["rev"] == rev
    restarted.wait_for_reports()
    ids = {r["instance_id"] for r in world.db.tables[maintenance.INSTANCES_TABLE]}
    assert "instance-a-restarted" in ids

    # The admin can carry on from the restarted process.
    assert world.checks().status_code == 200
    assert world.reopen().status_code == 200
    assert gate.get("/notes").status_code == 200

    # No timer objects anywhere, and each runtime has at most its own two pool threads.
    assert not [t for t in threading.enumerate() if isinstance(t, threading.Timer)]
    assert len(maintenance_threads()) <= len(before) + 2


def test_an_idle_instance_does_nothing(world):
    gate, _ = gate_app(world)
    world.to_draining()
    world.rt.wait_for_reports()
    calls = len(world.db.calls)
    world.clock.advance(minutes=30)  # time passes, no requests arrive
    assert len(world.db.calls) == calls  # no polling, no heartbeats
    gate.get("/notes")  # the next request refreshes once
    world.rt.wait_for_reports()
    reads = [c for c in world.db.calls[calls:] if c == (maintenance.STATE_TABLE, "select")]
    assert len(reads) == 1


def test_nothing_is_written_while_no_break_is_planned(world):
    gate, _ = gate_app(world)
    for _ in range(5):
        gate.get("/notes")
        gate.put("/notes/n1")
    world.rt.wait_for_reports()
    assert [c for c in world.db.writes() if c[0] == maintenance.INSTANCES_TABLE] == []


def test_reports_are_rate_limited_but_zero_is_always_sent(world):
    world.to_draining()
    world.rt.wait_for_reports()
    before = len([c for c in world.db.writes() if c[0] == maintenance.INSTANCES_TABLE])
    for _ in range(5):
        world.rt.request_started()  # five changes at once: coalesced, one write a second at most
    world.rt.wait_for_reports()
    middle = len([c for c in world.db.writes() if c[0] == maintenance.INSTANCES_TABLE])
    assert middle - before <= 2
    for _ in range(5):
        world.rt.request_finished()
    world.rt.wait_for_reports()
    row = next(r for r in world.db.tables[maintenance.INSTANCES_TABLE] if r["instance_id"] == "instance-a")
    assert row["in_flight"] == 0


def test_unreadable_state_keeps_the_last_known_phase(world, caplog):
    gate, _ = gate_app(world)
    world.to_active()
    world.db.fail_tables.add(maintenance.STATE_TABLE)
    world.clock.advance(seconds=10)
    response = gate.get("/notes")
    assert response.status_code == 503 and response.json()["error_code"] == "maintenance_active"
    # The log names the exception type only.
    assert "simulated database failure" not in caplog.text


def test_a_new_process_whose_first_read_fails_keeps_reads_open_and_refuses_changes():
    """Restart during a break while the database is slow or unreachable: the new process
    can't tell that a break is on, so it fails closed for changes (C.3, fixed)."""
    db = FakeMaintenanceDB()
    db.state["phase"] = "active"
    db.fail_tables.add(maintenance.STATE_TABLE)
    runtime = make_runtime(db, FakeClock(), "instance-z")
    maintenance.set_runtime(runtime)
    try:
        from tests.maintenance_fakes import World, gate_app as make_gate

        w = World(db=db, clock=runtime.clock, rt=runtime, who={"id": None}, client=None)
        gate, _ = make_gate(w)
        assert not runtime.state_known
        read = gate.get("/notes")
        assert read.status_code == 200  # reading stays open
        # ...but it never claims "no break, rev 0" while it doesn't know.
        assert "x-luma-maintenance" not in read.headers and "x-luma-maintenance-rev" not in read.headers
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        status_app = FastAPI()
        status_app.include_router(maintenance.maintenance_router)
        status = TestClient(status_app).get("/maintenance/status")
        assert status.status_code == 503 and status.json()["error_code"] == "maintenance_unavailable"
        assert status.headers["Retry-After"] == str(maintenance.UNKNOWN_STATE_RETRY_SECONDS)
        assert "x-luma-maintenance" not in status.headers
        for method, path in [
            ("PUT", "/notes/n1"),
            ("POST", "/notes"),
            ("POST", "/api/summarize"),
            ("POST", "/api/stripe-webhook"),
            ("DELETE", "/me/account"),
            ("PATCH", "/me/profile"),
        ]:
            response = gate.request(method, path)
            assert response.status_code == 503, (method, path)
            body = response.json()
            assert body["error_code"] == "maintenance_unavailable"
            assert response.headers["Retry-After"] == str(maintenance.UNKNOWN_STATE_RETRY_SECONDS)
            assert "http" not in body["detail"] and "Exception" not in body["detail"]
        assert db.tables[maintenance.JOBS_TABLE] == []  # no AI job was started

        # Once a read works, it behaves as before: the stored break is enforced.
        db.fail_tables.discard(maintenance.STATE_TABLE)
        runtime.clock.advance(seconds=10)
        response = gate.put("/notes/n1")
        assert response.status_code == 503 and response.json()["error_code"] == "maintenance_active"
        assert runtime.state_known

        # And with no break stored, changes go through.
        db.state["phase"] = "none"
        db.state["rev"] = int(db.state.get("rev") or 0) + 1
        runtime.clock.advance(seconds=10)
        assert gate.put("/notes/n1").status_code == 200
        assert gate.get("/notes").headers["x-luma-maintenance"] == "none"
    finally:
        maintenance.set_runtime(None)


def test_a_process_whose_first_read_works_but_finds_no_row_is_open():
    """Local development (no break tables configured) and a missing row both read as 'none'."""
    db = FakeMaintenanceDB(seed_state=False)
    runtime = make_runtime(db, FakeClock(), "instance-y")
    maintenance.set_runtime(runtime)
    try:
        from tests.maintenance_fakes import World, gate_app as make_gate

        w = World(db=db, clock=runtime.clock, rt=runtime, who={"id": None}, client=None)
        gate, _ = make_gate(w)
        assert gate.put("/notes/n1").status_code == 200
        assert runtime.state_known
    finally:
        maintenance.set_runtime(None)


def test_admin_routes_report_trouble_plainly_when_the_table_is_missing(world):
    world.db.missing_tables.add(maintenance.STATE_TABLE)
    response = world.as_admin().get("/admin/maintenance")
    assert response.status_code == 503
    assert response.json() == {
        "detail": "We can't reach the break settings right now. Try again in a minute.",
        "error_code": "maintenance_unavailable",
    }


def test_two_workers_on_one_render_instance_get_their_own_rows(world, monkeypatch):
    """With WEB_CONCURRENCY > 1, several uvicorn workers share one RENDER_INSTANCE_ID.
    Each still gets its own instance row, and the admin's worker counts its sibling's work."""
    monkeypatch.setenv("RENDER_INSTANCE_ID", "srv-shared-1")
    first = maintenance.make_instance_id(pid=101)
    second = maintenance.make_instance_id(pid=102)
    assert first != second
    assert first.startswith("srv-shared-1-101-") and second.startswith("srv-shared-1-102-")
    assert maintenance.make_instance_id(pid=101) != first  # even a reused pid gets a new id

    worker_a = make_runtime(world.db, world.clock, first)
    worker_b = make_runtime(world.db, world.clock, second)
    maintenance.set_runtime(worker_a)
    world.rt = worker_a
    world.to_draining()
    maintenance.set_runtime(worker_b)
    gate, _ = gate_app(world)
    gate.get("/notes")  # worker B reads the state (draining) and reports itself
    worker_b.request_started()  # a save is still running on worker B
    worker_b.wait_for_reports()
    worker_a.request_started()
    worker_a.request_finished()  # worker A writes its own row, not worker B's
    worker_a.wait_for_reports()
    rows = {r["instance_id"]: r for r in world.db.tables[maintenance.INSTANCES_TABLE]}
    assert rows[second]["in_flight"] == 1
    assert rows[first]["in_flight"] == 0

    maintenance.set_runtime(worker_a)
    world.clock.advance(minutes=6)
    worker_b.request_started()  # fresh heartbeat from B
    worker_b.wait_for_reports()
    refused = world.activate()
    assert refused.status_code == 409
    assert [r["code"] for r in refused.json()["reasons"]] == ["requests_in_flight"]
    worker_b.request_finished()
    worker_b.request_finished()
    worker_b.wait_for_reports()
    assert world.activate().status_code == 200
