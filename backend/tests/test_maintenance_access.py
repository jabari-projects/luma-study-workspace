"""Maintenance can't be used to get around access control (fake database, synthetic users).

- Every admin route answers 403 to a signed-in student and 401 to no one, in every phase.
- No header, query, cookie or edit-session token gets a student (or an admin) past an
  active break on student routes.
- The public status endpoint says nothing about instances, jobs, counts or backups.
"""

import pytest

from app import maintenance
from tests.maintenance_fakes import world  # noqa: F401

ADMIN_CALLS = [
    ("GET", "/admin/maintenance", None),
    ("POST", "/admin/maintenance/schedule", {"start_local": "2026-12-01T05:00", "estimated_end_local": "2026-12-01T06:00", "reason": "other"}),
    ("POST", "/admin/maintenance/postpone", {"start_local": "2026-12-02T05:00", "estimated_end_local": "2026-12-02T06:00"}),
    ("POST", "/admin/maintenance/drain", {"grace_minutes": 5}),
    ("POST", "/admin/maintenance/activate", {"backup_ref": "20261201T103000Z", "backup_checked": True}),
    ("POST", "/admin/maintenance/checks", {}),
    ("POST", "/admin/maintenance/reopen", {}),
    ("POST", "/admin/maintenance/cancel", {}),
]
PHASE_STEPS = {
    "none": lambda w: None,
    "announced": lambda w: w.schedule(),
    "draining": lambda w: w.to_draining(),
    "active": lambda w: w.to_active(),
    "checking": lambda w: w.to_checking(),
}


def call(client, method, path, body, rev):
    if method == "GET":
        return client.get(path)
    return client.post(path, json={"expected_rev": rev, **(body or {})})


@pytest.mark.parametrize("phase", list(PHASE_STEPS))
def test_students_get_403_and_strangers_401_on_every_admin_route(world, phase):
    PHASE_STEPS[phase](world)
    assert world.db.state["phase"] == phase
    snapshot = dict(world.db.state)
    for method, path, body in ADMIN_CALLS:
        response = call(world.as_student(), method, path, body, world.rev())
        assert response.status_code == 403, (phase, path, response.text)
        response = call(world.signed_out(), method, path, body, world.rev())
        assert response.status_code == 401, (phase, path)
    assert world.db.state == snapshot  # nothing changed


def test_bypass_attempts_do_nothing(world):
    world.to_active()
    token = maintenance.make_edit_session_token(world.clock())
    tries = [
        {"headers": {"X-Luma-Maintenance-Bypass": "1"}},
        {"headers": {"X-Admin": "true", "X-Luma-Role": "admin"}},
        {"headers": {"X-Luma-Edit-Session": token}},
        {"headers": {"X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1"}},
        {"params": {"bypass": "1", "admin": "true", "maintenance": "off"}},
        {"cookies": {"admin": "1", "luma_bypass": "1"}},
    ]
    for client in (world.as_student(), world.as_admin()):
        for extra in tries:
            for method, path in (("GET", "/notes"), ("POST", "/notes"), ("PUT", "/notes/n1"), ("POST", "/api/generate-notes")):
                response = client.request(method, path, **extra)
                assert response.status_code == 503, (method, path, extra)
                assert response.json()["error_code"] == "maintenance_active"


def test_lookalike_paths_are_not_always_open(world):
    world.to_active()
    client = world.as_admin()
    for method, path in (
        ("GET", "/admin/maintenanceX"),
        ("GET", "/admin/reports"),
        ("POST", "/maintenance/status"),
        ("PUT", "/me/profile"),
        ("GET", "/me/profile/extra"),
        ("POST", "/auth/login"),
        ("GET", "/healthz"),
    ):
        response = client.request(method, path)
        assert response.status_code == 503, (method, path)


def test_admin_routes_still_check_the_admin_during_a_break(world):
    world.to_active()
    # The admin passes the gate AND require_admin; a student passes the gate but not require_admin.
    assert world.as_admin().get("/admin/maintenance").status_code == 200
    assert world.as_student().get("/admin/maintenance").status_code == 403
    # Sign-in stays open so the admin can get back in.
    assert maintenance.classify("POST", "/login") == (maintenance.ALWAYS_OPEN, None)


def test_status_endpoint_shows_only_public_fields(world):
    world.to_active(reason="database_update")
    world.db.tables[maintenance.JOBS_TABLE].append(
        {"job_id": "j1", "instance_id": "secret-host-123", "kind": "upload", "started_at": "x", "expected_end_at": "2099-01-01T00:00:00Z"}
    )
    response = world.signed_out().get("/maintenance/status")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "phase", "rev", "reason", "note", "start_at", "estimated_end_at",
        "drain_started_at", "grace_ends_at", "recently_reopened", "server_time",
    }
    text = response.text
    for secret in ("instance", "secret-host", "job", "backup", "2026120", "counts", "admin-1", "updated_by"):
        assert secret not in text, secret
    assert response.headers["cache-control"] == "no-store"


def test_edit_session_needs_a_signed_in_student(world):
    assert world.signed_out().post("/maintenance/edit-session").status_code == 401
    response = world.as_student().post("/maintenance/edit-session")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"token", "issued_at"}
    assert maintenance.edit_session_issued_at(body["token"], world.clock()) is not None
