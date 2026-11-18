"""The fake API (frontend/dev/mock-api.mjs) must answer like the real backend.

Every Playwright test for saving, conflicts, retries and maintenance runs against the fake
API. This test sends the same scripted requests to the real FastAPI app (TestClient, in-memory
fake database) and to a running mock-api.mjs, and compares status codes, error codes, JSON key
sets and the maintenance headers. If either side drifts, this fails.

Synthetic data only. The fake API runs on 127.0.0.1 on a free port and is stopped at the end.
Skips (with the reason) when Node.js or the frontend folder isn't there.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest

from app import maintenance
from tests.maintenance_fakes import FakeClock, FakeMaintenanceDB, make_runtime
from tests.work_fakes import student, work_api, work_db  # noqa: F401

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
MOCK = FRONTEND / "dev" / "mock-api.mjs"
DEMO = {"email": "demo@luma.test", "password": "demo-password"}  # the fake API's made-up account

# Keys the frontend reads from each answer. Both sides must have at least these.
NOTE_KEYS = {"id", "title", "content", "version"}
CONFLICT_KEYS = {"detail", "error_code", "current"}
GONE_KEYS = {"detail", "error_code"}
BREAK_KEYS = {"detail", "error_code", "retry_after", "maintenance"}
STATUS_KEYS = {
    "phase", "rev", "reason", "note", "start_at", "estimated_end_at", "drain_started_at",
    "grace_ends_at", "recently_reopened", "server_time",
}
PROGRESS_KEYS = {"version", "progress_rev"}


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Mock:
    """A tiny HTTP client for the running fake API."""

    def __init__(self, base: str):
        self.base = base
        self.token: str | None = None

    def call(self, method: str, path: str, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("content-type", "application/json")
        if self.token:
            request.add_header("authorization", f"Bearer {self.token}")
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read() or b"null"), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"null"), dict(error.headers)


@pytest.fixture(scope="module")
def mock():
    node = shutil.which("node")
    if node is None or not MOCK.is_file():
        pytest.skip("Node.js or frontend/dev/mock-api.mjs is not available")
    port = _free_port()
    proc = subprocess.Popen(
        [node, str(MOCK)], cwd=str(FRONTEND), env={**os.environ, "PORT": str(port)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    client = Mock(f"http://127.0.0.1:{port}")
    try:
        # A bounded wait for the fake API to start (at most 15 s), then stop for good.
        deadline = time.monotonic() + 15
        while True:
            try:
                if client.call("GET", "/health")[0] == 200:
                    break
            except OSError:
                pass
            if time.monotonic() > deadline:
                pytest.fail("the fake API did not start")
            time.sleep(0.2)
        status, body, _ = client.call("POST", "/login", DEMO)
        assert status == 200, body
        client.token = body["access_token"]
        yield client
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def _keys(body) -> set[str]:
    return set(body) if isinstance(body, dict) else set()


def _lower(headers: dict) -> dict:
    return {k.lower(): v for k, v in headers.items()}


def test_create_replay_conflict_and_gone_match(mock, work_api):
    key = str(uuid.uuid4())
    body = {"title": "SYNTH contract", "content": "SYNTH first", "tags": []}
    real = work_api.post("/notes", json=body, headers={"Idempotency-Key": key})
    fake = mock.call("POST", "/notes", body, {"Idempotency-Key": key})
    assert (real.status_code, fake[0]) == (201, 201)
    assert NOTE_KEYS <= _keys(real.json()) and NOTE_KEYS <= _keys(fake[1])
    assert real.json()["version"] == fake[1]["version"] == 1

    # The same key again: 200 with the same id, and the replay header.
    real_again = work_api.post("/notes", json=body, headers={"Idempotency-Key": key})
    fake_again = mock.call("POST", "/notes", body, {"Idempotency-Key": key})
    assert (real_again.status_code, fake_again[0]) == (200, 200)
    assert real_again.json()["id"] == real.json()["id"]
    assert fake_again[1]["id"] == fake[1]["id"]
    assert real_again.headers.get("idempotent-replay") == _lower(fake_again[2]).get("idempotent-replay") == "true"

    # A key that is not a uuid: 422 on both.
    assert work_api.post("/notes", json=body, headers={"Idempotency-Key": "nope"}).status_code == 422
    assert mock.call("POST", "/notes", body, {"Idempotency-Key": "nope"})[0] == 422

    real_id, fake_id = real.json()["id"], fake[1]["id"]
    # A fresh save, then a stale one: 409 edit_conflict with the newer row.
    edit = {"content": "SYNTH second", "expected_version": 1}
    assert work_api.put(f"/notes/{real_id}", json=edit).json()["version"] == 2
    assert mock.call("PUT", f"/notes/{fake_id}", edit)[1]["version"] == 2
    stale = {"content": "SYNTH from an old tab", "expected_version": 1}
    real_409 = work_api.put(f"/notes/{real_id}", json=stale)
    fake_409 = mock.call("PUT", f"/notes/{fake_id}", stale)
    assert (real_409.status_code, fake_409[0]) == (409, 409)
    assert _keys(real_409.json()) == _keys(fake_409[1]) == CONFLICT_KEYS
    assert real_409.json()["error_code"] == fake_409[1]["error_code"] == "edit_conflict"
    assert NOTE_KEYS <= _keys(real_409.json()["current"]) and NOTE_KEYS <= _keys(fake_409[1]["current"])
    assert real_409.json()["current"]["version"] == fake_409[1]["current"]["version"] == 2

    # The same save sent again after it landed: 200, not 409, on both.
    assert work_api.put(f"/notes/{real_id}", json=edit).status_code == 200
    assert mock.call("PUT", f"/notes/{fake_id}", edit)[0] == 200

    # A save to an item that is gone: 404 item_gone.
    missing = str(uuid.uuid4())
    real_404 = work_api.put(f"/notes/{missing}", json=edit)
    fake_404 = mock.call("PUT", f"/notes/{missing}", edit)
    assert (real_404.status_code, fake_404[0]) == (404, 404)
    assert _keys(real_404.json()) == _keys(fake_404[1]) == GONE_KEYS
    assert real_404.json()["error_code"] == fake_404[1]["error_code"] == "item_gone"


def test_flashcard_progress_answers_match(mock, work_api):
    deck = {"title": "SYNTH deck", "cards": [{"id": "c1", "front": "Q1", "back": "A1"}]}
    real = work_api.post("/flashcards", json=deck).json()
    fake = mock.call("POST", "/flashcards", deck)[1]
    review = {"due": "2026-11-20T00:00:00+00:00", "stability": 3.1, "difficulty": 5, "elapsed_days": 0,
              "scheduled_days": 1, "learning_steps": 0, "reps": 1, "lapses": 0, "state": 1, "last_review": None}
    real_p = work_api.patch(f"/flashcards/{real['id']}/progress", json={"reviews": {"c1": review}})
    fake_p = mock.call("PATCH", f"/flashcards/{fake['id']}/progress", {"reviews": {"c1": review}})
    assert (real_p.status_code, fake_p[0]) == (200, 200)
    assert _keys(real_p.json()) == _keys(fake_p[1]) == PROGRESS_KEYS
    assert real_p.json() == fake_p[1] == {"version": 1, "progress_rev": 1}
    assert work_api.patch(f"/flashcards/{real['id']}/progress", json={"reviews": {}}).status_code == 422
    assert mock.call("PATCH", f"/flashcards/{fake['id']}/progress", {"reviews": {}})[0] == 422


@pytest.mark.parametrize("phase", ["none", "announced", "active"])
def test_maintenance_status_and_break_answers_match(mock, work_api, phase):
    clock = FakeClock()
    mdb = FakeMaintenanceDB()
    times = {}
    if phase != "none":
        start = clock() if phase == "active" else clock().replace(year=clock().year + 1)
        times = {"start_at": maintenance.iso(start), "estimated_end_at": maintenance.iso(start.replace(hour=start.hour + 1))}
    mdb.state.update({"phase": phase, "reason": "website_update" if phase != "none" else "", **times})
    maintenance.set_runtime(make_runtime(mdb, clock, "instance-contract"))
    fake_set = mock.call("POST", "/__test/maintenance", {"phase": phase, "reason": "website_update" if phase != "none" else "", **times})
    assert fake_set[0] == 200
    try:
        real_status = work_api.get("/maintenance/status")
        fake_status = mock.call("GET", "/maintenance/status")
        assert (real_status.status_code, fake_status[0]) == (200, 200)
        assert _keys(real_status.json()) == _keys(fake_status[1]) == STATUS_KEYS
        assert real_status.json()["phase"] == fake_status[1]["phase"] == phase
        assert real_status.headers["cache-control"] == "no-store"

        save = {"content": "SYNTH during a break", "expected_version": 1}
        real_put = work_api.put(f"/notes/{uuid.uuid4()}", json=save)
        fake_put = mock.call("PUT", f"/notes/{uuid.uuid4()}", save)
        if phase == "active":
            assert (real_put.status_code, fake_put[0]) == (503, 503)
            assert _keys(real_put.json()) == _keys(fake_put[1]) == BREAK_KEYS
            assert real_put.json()["error_code"] == fake_put[1]["error_code"] == "maintenance_active"
            assert _keys(real_put.json()["maintenance"]) == _keys(fake_put[1]["maintenance"])
            fake_headers = _lower(fake_put[2])
            for header in ("retry-after", "x-luma-maintenance", "x-luma-maintenance-rev"):
                assert header in real_put.headers and header in fake_headers, header
            assert int(real_put.headers["retry-after"]) > 0 and int(fake_headers["retry-after"]) > 0
            assert real_put.headers["x-luma-maintenance"] == fake_headers["x-luma-maintenance"] == "active"
        else:
            # Not a break: the gate lets it through to the route (an unknown note is item_gone).
            assert (real_put.status_code, fake_put[0]) == (404, 404)
            assert real_put.headers["x-luma-maintenance"] == _lower(fake_put[2])["x-luma-maintenance"] == phase
    finally:
        maintenance.set_runtime(None)
        mock.call("POST", "/__test/maintenance", {"phase": "none"})
