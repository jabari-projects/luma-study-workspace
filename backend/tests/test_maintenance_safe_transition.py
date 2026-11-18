"""Entering maintenance only when it is safe (section C.5), on a fake database.

In-flight jobs block activation; stale jobs (a crashed process) are reported but don't block;
requests in flight on another instance block; an instance that stopped reporting mid-work
blocks for up to 10 minutes; the grace period and the 60 s settle time are respected; a
refused activation changes nothing and writes a log row.
"""

from datetime import timedelta

from app import maintenance
from tests.maintenance_fakes import gate_app, world  # noqa: F401


def reasons(response):
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["error_code"] == "maintenance_not_safe" and body["detail"] == "It isn't safe to start yet."
    return {r["code"]: r for r in body["reasons"]}


def job_row(w, kind="ai_transcribe", ends_in=timedelta(minutes=2), instance="instance-b"):
    now = w.clock()
    row = {
        "job_id": f"00000000-0000-4000-8000-{len(w.db.tables['maintenance_jobs']):012d}",
        "instance_id": instance,
        "kind": kind,
        "started_at": maintenance.iso(now - timedelta(minutes=1)),
        "expected_end_at": maintenance.iso(now + ends_in),
    }
    w.db.tables[maintenance.JOBS_TABLE].append(row)
    return row


def instance_row(w, instance_id, in_flight, age):
    w.db.tables[maintenance.INSTANCES_TABLE].append(
        {
            "instance_id": instance_id,
            "started_at": maintenance.iso(w.clock() - timedelta(hours=1)),
            "heartbeat_at": maintenance.iso(w.clock() - age),
            "in_flight": in_flight,
            "phase_seen": "draining",
            "code_version": "x",
        }
    )


def test_grace_period_must_be_over(world):
    world.to_draining()  # grace 5 minutes
    world.clock.advance(minutes=2)
    got = reasons(world.activate())
    assert got["grace_not_over"]["seconds_left"] == 180
    assert world.db.state["phase"] == "draining"
    log = world.db.tables[maintenance.LOG_TABLE][-1]
    assert log["action"] == "activate_refused" and log["detail"] == {"reasons": ["grace_not_over"]}


def test_settle_time_counts_even_with_a_short_grace(world):
    world.to_draining()
    # Pretend the grace ended right away: the 60 s settle time still applies.
    world.db.state["grace_ends_at"] = world.db.state["drain_started_at"]
    world.clock.advance(seconds=30)
    assert reasons(world.activate())["grace_not_over"]["seconds_left"] == 30


def test_running_jobs_block_and_stale_jobs_do_not(world):
    world.to_draining()
    world.clock.advance(minutes=6)
    job_row(world, ends_in=timedelta(minutes=2))
    job_row(world, kind="account_deletion", ends_in=timedelta(minutes=4))
    stale = job_row(world, ends_in=timedelta(minutes=-3))  # its process crashed
    got = reasons(world.activate())
    assert got == {"jobs_running": {"code": "jobs_running", "count": 2}}
    view = world.as_admin().get("/admin/maintenance").json()
    assert view["jobs"] == {"running": 2, "stale": 1, "by_kind": {"ai_transcribe": 1, "account_deletion": 1}}
    # The jobs finish (their rows are deleted); the stale one is left and doesn't block.
    world.db.tables[maintenance.JOBS_TABLE] = [stale]
    assert world.activate().status_code == 200
    assert world.db.state["phase"] == "active"


def test_requests_in_flight_on_another_instance_block(world):
    world.to_draining()
    world.clock.advance(minutes=6)
    instance_row(world, "instance-b", in_flight=3, age=timedelta(seconds=20))
    instance_row(world, "instance-old", in_flight=5, age=timedelta(minutes=30))  # long gone: ignored
    got = reasons(world.activate())
    assert got == {"requests_in_flight": {"code": "requests_in_flight", "count": 3}}
    next(r for r in world.db.tables[maintenance.INSTANCES_TABLE] if r["instance_id"] == "instance-b")["in_flight"] = 0
    assert world.activate().status_code == 200


def test_an_instance_that_went_quiet_mid_work_blocks(world):
    world.to_draining()
    world.clock.advance(minutes=6)
    instance_row(world, "instance-c", in_flight=1, age=timedelta(minutes=5))
    instance_row(world, "instance-d", in_flight=0, age=timedelta(minutes=5))  # quiet but idle: fine
    assert reasons(world.activate()) == {"instance_silent": {"code": "instance_silent", "count": 1}}
    world.clock.advance(minutes=6)  # now over 10 minutes old: treated as gone
    assert world.activate().status_code == 200


def test_this_instances_own_requests_count(world):
    world.to_draining()
    world.clock.advance(minutes=6)
    world.rt.request_started()  # a student's save still running here
    got = reasons(world.activate())
    assert got["requests_in_flight"]["count"] == 1
    world.rt.request_finished()
    assert world.activate().status_code == 200


def test_every_reason_is_listed_at_once(world):
    world.to_draining(reason="database_update")
    job_row(world)
    instance_row(world, "instance-b", in_flight=1, age=timedelta(seconds=5))
    instance_row(world, "instance-c", in_flight=1, age=timedelta(minutes=4))
    got = reasons(world.activate())
    assert set(got) == {"grace_not_over", "jobs_running", "requests_in_flight", "instance_silent", "backup_missing"}


def test_database_trouble_during_activation_refuses(world):
    world.to_draining()
    world.clock.advance(minutes=6)
    world.db.fail_tables.add("notes")  # counting rows fails
    got = reasons(world.activate())
    assert "database_unreachable" in got
    assert world.db.state["phase"] == "draining"


def test_ai_requests_get_a_job_row_while_they_run(world):
    gate, seen = gate_app(world)
    response = gate.post("/api/transcribe")
    assert response.status_code == 200
    assert len(seen["jobs"]) == 1
    job = seen["jobs"][0]
    assert job["kind"] == "ai_transcribe" and job["instance_id"] == "instance-a"
    started = maintenance.parse_ts(job["started_at"])
    assert maintenance.parse_ts(job["expected_end_at"]) - started == timedelta(seconds=150 + 30)
    assert seen["in_flight"] == 1
    assert world.db.tables[maintenance.JOBS_TABLE] == []  # removed when it finished
    assert world.rt.in_flight == 0


def test_job_kinds_and_deadlines():
    expected = {
        ("POST", "/api/generate-notes"): ("ai_image", 100),
        ("POST", "/api/notes-from-text"): ("ai_notes", 100),
        ("POST", "/api/summarize"): ("ai_summary", 100),
        ("POST", "/api/transcribe"): ("ai_transcribe", 150),
        ("POST", "/api/import/link"): ("link_import", 20),
        ("DELETE", "/me/account"): ("account_deletion", 300),
        ("POST", "/me/avatar"): ("upload", 60),
        ("POST", "/me/theme-image"): ("upload", 60),
    }
    for (method, path), job in expected.items():
        assert maintenance.classify(method, path)[1] == job, path
    assert maintenance.classify("POST", "/signup") == (maintenance.LONG, None)
    assert maintenance.classify("GET", "/notes")[1] is None


def test_a_failed_job_row_never_breaks_the_students_request(world):
    gate, seen = gate_app(world)
    world.db.fail_tables.add(maintenance.JOBS_TABLE)
    response = gate.post("/api/summarize")
    assert response.status_code == 200 and response.json()["ok"] is True
    assert seen["in_flight"] == 1  # still counted


def test_admin_requests_are_not_counted_in_flight(world):
    gate, seen = gate_app(world)
    gate.get("/admin/maintenance")
    assert seen["in_flight"] == 0
    gate.get("/notes")
    assert seen["in_flight"] == 1
