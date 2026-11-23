"""Maintenance phases end to end on a fake database (synthetic data only).

Covers: the gate in every phase, typing during a drain (an open editor saves within the
grace period, a new editor is refused, after grace the save is refused), the exact 503
body and headers, failed deployment and recovery (reopen refused while checks fail,
dropping counts fail records_kept, activation refused without a backup stamp), postpone,
cancel and racing admins.
"""

from datetime import timedelta

import pytest

from app import maintenance
from tests.maintenance_fakes import SITE, gate_app, world  # noqa: F401

STUDENT_WRITE = ("POST", "/notes")
CASES = {
    "ai": ("POST", "/api/transcribe"),
    "long": ("DELETE", "/me/account"),
    "content_write": ("PUT", "/notes/n1"),
    "other_write": ("PUT", "/me/username"),
    "read": ("GET", "/notes"),
    "webhook": ("POST", "/api/stripe-webhook"),
    "status": ("GET", "/maintenance/status"),
    "login": ("POST", "/login"),
}


def hit(client, case, headers=None):
    method, path = CASES[case]
    return client.request(method, path, headers=headers or {})


def outcome(response):
    if response.status_code == 503:
        return response.json()["error_code"]
    assert response.status_code == 200, response.text
    return "ok"


def edit_token(w):
    response = w.as_student().post("/maintenance/edit-session")
    assert response.status_code == 200, response.text
    return response.json()["token"]


def test_none_and_announced_let_everything_through(world):
    gate, _ = gate_app(world)
    for case in CASES:
        assert outcome(hit(gate, case)) == "ok", case
    assert world.schedule().status_code == 200
    assert world.db.state["phase"] == "announced"
    for case in CASES:
        assert outcome(hit(gate, case)) == "ok", case


def test_draining_before_grace(world):
    gate, _ = gate_app(world)
    world.schedule()
    token = edit_token(world)  # an editor that opened before the drain
    world.clock.advance(seconds=30)
    assert world.drain(grace_minutes=10).status_code == 200
    got = {case: outcome(hit(gate, case)) for case in CASES}
    assert got == {
        "ai": "maintenance_draining",
        "long": "maintenance_draining",
        "content_write": "maintenance_draining",  # no edit session: a new editor is refused
        "other_write": "ok",
        "read": "ok",
        "webhook": "ok",
        "status": "ok",
        "login": "ok",
    }
    # The open editor can still save during the grace period.
    assert outcome(hit(gate, "content_write", {"X-Luma-Edit-Session": token})) == "ok"
    # A new editor can't start: no new edit-session tokens while draining.
    refused = world.as_student().post("/maintenance/edit-session")
    assert refused.status_code == 503 and refused.json()["error_code"] == "maintenance_draining"


def test_draining_after_grace_refuses_every_write_but_keeps_reads(world):
    gate, _ = gate_app(world)
    world.schedule()
    token = edit_token(world)
    world.clock.advance(seconds=30)
    world.drain(grace_minutes=5)
    world.clock.advance(minutes=5, seconds=1)
    got = {case: outcome(hit(gate, case)) for case in CASES}
    assert got["content_write"] == got["other_write"] == got["ai"] == got["webhook"] == "maintenance_draining"
    assert got["read"] == got["status"] == got["login"] == "ok"
    assert outcome(hit(gate, "content_write", {"X-Luma-Edit-Session": token})) == "maintenance_draining"


def test_edit_session_tokens_are_checked(world):
    gate, _ = gate_app(world)
    world.schedule()
    good = edit_token(world)
    world.clock.advance(seconds=10)
    world.drain(grace_minutes=10)
    world.clock.advance(seconds=10)
    payload, mac = good.split(".")
    forged = payload + "." + ("A" if mac[0] != "A" else "B") + mac[1:]
    late = maintenance.make_edit_session_token(world.clock())  # made after the drain began
    for bad in (forged, late, "nonsense", "a.b", good + "x", ""):
        assert outcome(hit(gate, "content_write", {"X-Luma-Edit-Session": bad})) == "maintenance_draining", bad
    assert outcome(hit(gate, "content_write", {"X-Luma-Edit-Session": good})) == "ok"
    # Tokens last 24 hours.
    old = maintenance.make_edit_session_token(world.clock() - timedelta(hours=25))
    assert maintenance.edit_session_issued_at(old, world.clock()) is None


def test_active_blocks_everything_but_the_always_open_list(world):
    gate, _ = gate_app(world)
    world.to_active()
    got = {case: outcome(hit(gate, case)) for case in CASES}
    assert got == {
        "ai": "maintenance_active",
        "long": "maintenance_active",
        "content_write": "maintenance_active",
        "other_write": "maintenance_active",
        "read": "maintenance_active",
        "webhook": "maintenance_active",
        "status": "ok",
        "login": "ok",
    }
    for path in ("/health", "/health/ready", "/robots.txt", "/me/profile", "/admin/maintenance"):
        assert outcome(gate.get(path)) == "ok", path


def test_active_503_body_and_headers_are_exact(world):
    world.to_active()
    response = world.as_student().get("/notes", headers={"Origin": SITE})
    assert response.status_code == 503
    body = response.json()
    assert set(body) == {"detail", "error_code", "retry_after", "maintenance"}
    assert body["detail"] == "Luma is taking a short break. Your saved work is safe. Please try again after the break."
    assert body["error_code"] == "maintenance_active"
    # Estimated end 06:00 CST = 12:00Z; the clock is at 10:06Z, so 1h54m, clamped to 3600 s.
    assert body["retry_after"] == 3600
    assert body["maintenance"] == {"phase": "active", "estimated_end_at": "2026-12-01T12:00:00Z"}
    assert response.headers["retry-after"] == "3600"
    assert response.headers["x-luma-maintenance"] == "active"
    assert response.headers["x-luma-maintenance-rev"] == str(world.rev())
    # CORS wraps the gate, so the browser can read the 503 and its headers.
    assert response.headers["access-control-allow-origin"] == SITE
    exposed = response.headers["access-control-expose-headers"].lower()
    for name in ("x-luma-maintenance", "x-luma-maintenance-rev", "retry-after", "x-request-id"):
        assert name in exposed


def test_retry_after_is_clamped():
    now = maintenance.utc_now()
    assert maintenance.retry_after_seconds({"estimated_end_at": None}, now) == 900
    assert maintenance.retry_after_seconds({"estimated_end_at": maintenance.iso(now + timedelta(seconds=10))}, now) == 60
    assert maintenance.retry_after_seconds({"estimated_end_at": maintenance.iso(now - timedelta(hours=1))}, now) == 60
    assert maintenance.retry_after_seconds({"estimated_end_at": maintenance.iso(now + timedelta(minutes=20))}, now) == 1200
    assert maintenance.retry_after_seconds({"estimated_end_at": maintenance.iso(now + timedelta(hours=5))}, now) == 3600


def test_draining_body_uses_the_draining_words(world):
    world.to_draining()
    response = world.as_student().post("/api/transcribe")
    assert response.status_code == 503
    assert response.json()["error_code"] == "maintenance_draining"
    assert response.json()["detail"].startswith("Luma is getting ready for a short break")


def test_every_passing_response_carries_the_phase_headers(world):
    response = world.signed_out().get("/health", headers={"Origin": SITE})
    assert response.status_code == 200
    assert response.headers["x-luma-maintenance"] == "none"
    assert response.headers["x-luma-maintenance-rev"] == "1"
    world.schedule()
    response = world.signed_out().get("/health")
    assert response.headers["x-luma-maintenance"] == "announced"
    assert response.headers["x-luma-maintenance-rev"] == "2"


def test_full_break_and_reopen(world):
    world.to_active(reason="database_update")
    state = world.db.state
    assert state["phase"] == "active" and state["backup_ref"] == "20261201T103000Z"
    assert state["counts_at_activation"] == {
        "users": 2, "profiles": 2, "notes": 3, "summaries": 1, "flashcards": 1, "study_sessions": 0,
        "transcripts": 1, "feedback_responses": 1, "feedback_answers": 2,
    }
    checks = world.checks()
    assert checks.status_code == 200
    results = {r["name"]: r["passed"] for r in world.db.state["checks"]["results"]}
    assert results == {"database": True, "schema": True, "records_kept": True, "log_write": True, "storage": True, "code_version": True}
    assert world.db.state["phase"] == "checking" and world.db.state["checks_passed_at"]
    reopened = world.reopen()
    assert reopened.status_code == 200
    assert world.db.state["phase"] == "none"
    status = world.signed_out().get("/maintenance/status").json()
    assert status["phase"] == "none" and status["recently_reopened"] is True
    world.clock.advance(minutes=31)
    status = world.signed_out().get("/maintenance/status").json()
    assert status["recently_reopened"] is False
    actions = [row["action"] for row in world.db.tables[maintenance.LOG_TABLE]]
    for action in ("schedule", "drain", "activate", "checks", "reopen"):
        assert action in actions


def test_failed_checks_keep_luma_closed(world):
    world.to_active()
    world.db.storage_fails = True
    assert world.checks().status_code == 200
    failed = [r["name"] for r in world.db.state["checks"]["results"] if not r["passed"]]
    assert failed == ["storage"]
    assert world.db.state["checks_passed_at"] is None
    refused = world.reopen()
    assert refused.status_code == 409 and refused.json()["error_code"] == "checks_not_passed"
    assert world.db.state["phase"] == "checking"
    # Students are still kept out while checking.
    assert world.as_student().get("/notes").json()["error_code"] == "maintenance_active"
    # Fix it (a code rollback, say) and run the checks again: now it can reopen.
    world.db.storage_fails = False
    assert world.checks().status_code == 200
    assert world.reopen().status_code == 200


def test_dropping_counts_fail_records_kept(world):
    world.to_active()
    world.db.tables["notes"].pop()  # a "migration" lost a note
    world.checks()
    records = next(r for r in world.db.state["checks"]["results"] if r["name"] == "records_kept")
    assert records["passed"] is False
    assert records["detail"]["dropped"] == {"notes": {"before": 3, "now": 2}}
    assert world.reopen().json()["error_code"] == "checks_not_passed"


@pytest.mark.parametrize("table", ["transcripts", "feedback_responses", "feedback_answers"])
def test_losing_a_transcript_or_a_ballot_fails_records_kept(world, table):
    world.to_active()
    before = len(world.db.tables[table])
    world.db.tables[table].pop()
    world.checks()
    records = next(r for r in world.db.state["checks"]["results"] if r["name"] == "records_kept")
    assert records["passed"] is False
    assert records["detail"]["dropped"] == {table: {"before": before, "now": before - 1}}


def test_dropping_counts_may_be_explained_only_for_reason_other(world):
    world.to_active()  # website_update
    world.db.tables["notes"].pop()
    world.checks(counts_drop_reason="cleaned test rows")
    assert next(r for r in world.db.state["checks"]["results"] if r["name"] == "records_kept")["passed"] is False


def test_dropping_counts_explained_for_other(world):
    assert world.schedule(reason="other").status_code == 200
    world.drain()
    world.clock.advance(minutes=6)
    assert world.activate().status_code == 200
    world.db.tables["notes"].pop()
    world.checks(counts_drop_reason="removed spam notes by hand")
    records = next(r for r in world.db.state["checks"]["results"] if r["name"] == "records_kept")
    assert records["passed"] is True and records["detail"]["explained"] is True
    assert "spam" not in str(world.db.tables[maintenance.LOG_TABLE])  # typed text is not logged


def test_old_checks_must_be_run_again(world):
    world.to_checking()
    world.clock.advance(minutes=31)
    refused = world.reopen()
    assert refused.status_code == 409 and refused.json()["error_code"] == "checks_too_old"


def test_database_update_needs_a_checked_backup_stamp(world):
    world.to_draining(reason="database_update")
    world.clock.advance(minutes=6)
    for body in ({}, {"backup_ref": "20261201T103000Z"}, {"backup_ref": "yesterday", "backup_checked": True},
                 {"backup_ref": "G:/LumaBackups/20261201T103000Z", "backup_checked": True}):
        response = world.activate(**body)
        assert response.status_code == 409, body
        assert response.json()["reasons"] == [{"code": "backup_missing"}]
    assert world.db.state["phase"] == "draining"
    assert world.activate(backup_ref="20261201T103000Z", backup_checked=True).status_code == 200


def test_racing_admins_get_maintenance_changed(world):
    world.schedule()
    stale_rev = world.rev()
    assert world.drain().status_code == 200
    response = world.as_admin().post("/admin/maintenance/cancel", json={"expected_rev": stale_rev})
    assert response.status_code == 409 and response.json()["error_code"] == "maintenance_changed"
    assert world.db.state["phase"] == "draining"


def test_cas_lost_between_read_and_write(world, monkeypatch):
    world.schedule()
    store = world.rt.store
    real = store.cas_update

    def someone_else_first(expected_rev, changes):
        world.db.state["rev"] = expected_rev + 1  # another admin's write landed first
        return real(expected_rev, changes)

    monkeypatch.setattr(store, "cas_update", someone_else_first)
    response = world.drain()
    assert response.status_code == 409 and response.json()["error_code"] == "maintenance_changed"


def test_wrong_step_is_refused(world):
    response = world.as_admin().post("/admin/maintenance/activate", json={"expected_rev": world.rev()})
    assert response.status_code == 409 and response.json()["phase"] == "none"
    assert world.reopen().status_code == 409
    assert world.as_admin().post("/admin/maintenance/cancel", json={"expected_rev": world.rev()}).status_code == 409


def test_postpone_and_cancel(world):
    world.to_draining()
    response = world.as_admin().post(
        "/admin/maintenance/postpone",
        json={"expected_rev": world.rev(), "start_local": "2026-12-02T05:00", "estimated_end_local": "2026-12-02T06:00"},
    )
    assert response.status_code == 200
    state = world.db.state
    assert state["phase"] == "announced" and state["start_at"] == "2026-12-02T11:00:00Z"
    assert state["drain_started_at"] is None and state["grace_ends_at"] is None
    gate, _ = gate_app(world)
    assert outcome(hit(gate, "ai")) == "ok"
    response = world.as_admin().post("/admin/maintenance/cancel", json={"expected_rev": world.rev()})
    assert response.status_code == 200 and world.db.state["phase"] == "none"
    assert world.db.state["start_at"] is None


@pytest.mark.parametrize(
    "start,end,code",
    [
        ("2026-12-01T04:10", "2026-12-01T05:00", "time_too_soon"),  # 10 minutes from now
        ("2026-12-01T05:00", "2026-12-01T05:00", "time_order"),
        ("2026-12-01 05:00", "2026-12-01T06:00", "time_invalid"),
        ("2026-12-01T25:00", "2026-12-01T06:00", "time_invalid"),
    ],
)
def test_bad_times_are_refused(world, start, end, code):
    response = world.schedule(start=start, end=end)
    assert response.status_code == 422 and response.json()["error_code"] == code
    assert world.db.state["phase"] == "none"


def test_admin_view_shows_counts_and_log_without_student_data(world):
    world.to_draining()
    view = world.as_admin().get("/admin/maintenance").json()
    assert view["state"]["phase"] == "draining"
    assert view["jobs"] == {"running": 0, "stale": 0, "by_kind": {}}
    assert any(i["this_one"] for i in view["instances"])
    assert {row["action"] for row in view["log"][:2]} == {"drain", "schedule"}
    assert view["safety"][0]["code"] == "grace_not_over"
    text = str(view)
    assert "SYNTH" not in text and "example.test" not in text


def test_missing_column_fails_schema_check_and_blocks_reopen(world, monkeypatch):
    """A deploy whose code needs notes.version, without the student-work migration, must
    not reopen: every save would fail."""
    from tests import maintenance_fakes

    world.to_active()
    monkeypatch.setitem(maintenance_fakes.TABLE_COLUMNS, "notes", {"id", "user_id", "title", "create_key"})
    assert world.checks().status_code == 200
    results = {r["name"]: r for r in world.db.state["checks"]["results"]}
    assert results["schema"]["passed"] is False
    assert results["schema"]["detail"] == {"failed_tables": ["notes"]}
    assert world.db.state["checks_passed_at"] is None
    refused = world.reopen()
    assert refused.status_code == 409 and refused.json()["error_code"] == "checks_not_passed"
    # Apply the migration (the column exists again), check again, and it can reopen.
    monkeypatch.setitem(maintenance_fakes.TABLE_COLUMNS, "notes", {"id", "user_id", "title", "version", "create_key"})
    assert world.checks().status_code == 200
    assert world.reopen().status_code == 200


def test_required_schema_includes_student_work_columns():
    for table in ("notes", "summaries", "flashcards", "study_sessions"):
        assert {"version", "create_key"} <= set(maintenance.REQUIRED_SCHEMA[table]), table
    assert "progress_rev" in maintenance.REQUIRED_SCHEMA["flashcards"]


def test_two_code_versions_running_fail_the_code_version_check(world):
    """A deploy still rolling out (or half failed) leaves two code versions answering."""
    world.to_active()
    now = world.clock()
    world.db.tables[maintenance.INSTANCES_TABLE].append({
        "instance_id": "instance-new", "started_at": maintenance.iso(now), "heartbeat_at": maintenance.iso(now),
        "in_flight": 0, "phase_seen": "active", "code_version": "other-commit",
    })
    assert world.checks().status_code == 200
    results = {r["name"]: r for r in world.db.state["checks"]["results"]}
    assert results["code_version"]["passed"] is False
    assert results["code_version"]["detail"]["versions_seen"] == 2
    assert world.reopen().json()["error_code"] == "checks_not_passed"
    # The old server has gone quiet for over two minutes (the deploy finished): it passes.
    world.clock.advance(minutes=3)
    assert world.checks().status_code == 200
    results = {r["name"]: r for r in world.db.state["checks"]["results"]}
    assert results["code_version"]["passed"] is True


def test_webhooks_wait_in_the_last_settle_seconds_of_the_grace(world):
    """Payment events are refused (Stripe retries them) from DRAIN_SETTLE_SECONDS before the
    grace ends, so a server with a stale 'draining' copy or a slow clock can't write after
    the break starts."""
    gate, _ = gate_app(world)
    world.schedule()
    world.drain(grace_minutes=5)
    world.clock.advance(minutes=5, seconds=-(maintenance.DRAIN_SETTLE_SECONDS + 1))
    assert outcome(hit(gate, "webhook")) == "ok"
    world.clock.advance(seconds=2)
    response = hit(gate, "webhook")
    assert outcome(response) == "maintenance_draining"
    assert response.headers["retry-after"] == str(maintenance.WEBHOOK_RETRY_AFTER_SECONDS)
