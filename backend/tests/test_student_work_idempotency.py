"""Retry-safe creates: a lost answer, a double tap or a reload + retry make ONE row.

Synthetic data only, in-memory fake (tests/work_fakes.py).
"""

from __future__ import annotations

import threading
import uuid

import pytest
from fastapi.testclient import TestClient

from app import main
from tests.work_fakes import KINDS, TABLE_OF, student, work_api, work_db  # noqa: F401

each_kind = pytest.mark.parametrize("kind", list(KINDS))


def _key() -> str:
    return str(uuid.uuid4())


@each_kind
def test_first_create_is_201_and_stores_the_key(work_api, work_db, kind):
    key = _key()
    response = work_api.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": key})
    assert response.status_code == 201, response.text
    assert "Idempotent-Replay" not in response.headers
    assert response.json()["version"] == 1
    assert work_db.rows(TABLE_OF[kind])[0]["create_key"] == key
    assert "create_key" not in response.json()


@each_kind
def test_lost_answer_then_retry_returns_the_first_row_once(work_api, work_db, kind):
    key = _key()
    first = work_api.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": key})
    # The answer never reached the browser. It sends the same create again with the same key.
    retry = work_api.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": key})
    assert retry.status_code == 200, retry.text
    assert retry.headers["Idempotent-Replay"] == "true"
    assert retry.json()["id"] == first.json()["id"]
    assert retry.json()["version"] == 1
    assert len(work_db.rows(TABLE_OF[kind])) == 1


@each_kind
def test_double_tap_at_the_same_moment_makes_one_row(work_db, student, kind):
    from app.auth import get_current_user, get_current_user_id

    main.app.dependency_overrides[get_current_user_id] = lambda: student.id
    main.app.dependency_overrides[get_current_user] = lambda: {"id": student.id}
    key = _key()
    statuses: list[int] = []
    start = threading.Barrier(2)

    def tap():
        client = TestClient(main.app)
        start.wait()
        statuses.append(client.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": key}).status_code)

    try:
        threads = [threading.Thread(target=tap) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        main.app.dependency_overrides.pop(get_current_user_id, None)
        main.app.dependency_overrides.pop(get_current_user, None)
    assert sorted(statuses) == [200, 201]
    assert len(work_db.rows(TABLE_OF[kind])) == 1


@each_kind
def test_the_same_key_from_another_student_never_matches_or_leaks(work_api, work_db, student, kind):
    key = _key()
    mine = work_api.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": key}).json()
    student.id = "student-b"
    theirs = work_api.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": key})
    assert theirs.status_code == 201
    assert "Idempotent-Replay" not in theirs.headers
    assert theirs.json()["id"] != mine["id"]
    assert theirs.json()["user_id"] == "student-b"
    assert len(work_db.rows(TABLE_OF[kind])) == 2


@each_kind
def test_a_key_that_is_not_a_uuid_is_422_and_saves_nothing(work_api, work_db, kind):
    response = work_api.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": "not-a-uuid"})
    assert response.status_code == 422
    assert response.json()["error_code"] == "bad_idempotency_key"
    assert work_db.rows(TABLE_OF[kind]) == []


@each_kind
def test_no_key_still_works_like_before(work_api, work_db, kind):
    # An older cached frontend sends no key. Each tap makes a row, as it always did.
    for _ in range(2):
        assert work_api.post(f"/{kind}", json=KINDS[kind][0]).status_code == 201
    rows = work_db.rows(TABLE_OF[kind])
    assert len(rows) == 2
    assert all(row.get("create_key") is None for row in rows)


@each_kind
def test_the_key_header_is_trimmed_and_normalized(work_api, work_db, kind):
    key = _key()
    work_api.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": key.upper()})
    retry = work_api.post(f"/{kind}", json=KINDS[kind][0], headers={"Idempotency-Key": f" {key} "})
    assert retry.status_code == 200
    assert len(work_db.rows(TABLE_OF[kind])) == 1


def test_a_database_error_that_is_not_a_duplicate_still_fails(work_api, work_db, monkeypatch):
    from postgrest.exceptions import APIError

    def broken_insert(self, payload):
        raise APIError({"code": "57014", "message": "statement timeout"})

    from tests import work_fakes

    monkeypatch.setattr(work_fakes.WorkQuery, "insert", broken_insert)
    with pytest.raises(APIError):
        work_api.post("/notes", json=KINDS["notes"][0], headers={"Idempotency-Key": _key()})
