"""Version checks: another tab or device can never quietly overwrite newer work.

Synthetic data only, in-memory fake (tests/work_fakes.py).
"""

from __future__ import annotations

import pytest

from app.edit_versions import CONFLICT_DETAIL, MAX_CAS_ROUNDS
from tests.work_fakes import KINDS, TABLE_OF, student, work_api, work_db  # noqa: F401

each_kind = pytest.mark.parametrize("kind", list(KINDS))


def _create(work_api, kind):
    body, _ = KINDS[kind]
    response = work_api.post(f"/{kind}", json=body)
    assert response.status_code == 201, response.text
    return response.json()


@each_kind
def test_every_row_has_a_version(work_api, kind):
    created = _create(work_api, kind)
    assert created["version"] == 1
    assert work_api.get(f"/{kind}/{created['id']}").json()["version"] == 1
    assert [row["version"] for row in work_api.get(f"/{kind}").json()] == [1]


@each_kind
def test_save_with_the_loaded_version_lands_and_bumps_it(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    response = work_api.put(f"/{kind}/{created['id']}", json={**edit, "expected_version": 1})
    assert response.status_code == 200, response.text
    assert response.json()["version"] == 2
    stored = work_db.row(TABLE_OF[kind], created["id"])
    assert stored["version"] == 2
    for field, value in edit.items():
        assert stored[field] == value


@each_kind
def test_stale_tab_gets_409_with_the_newer_row_and_nothing_is_overwritten(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    field = next(iter(edit))
    first = work_api.put(f"/{kind}/{created['id']}", json={field: "SYNTH newer tab", "expected_version": 1})
    assert first.status_code == 200

    stale = work_api.put(f"/{kind}/{created['id']}", json={field: "SYNTH older tab", "expected_version": 1})
    assert stale.status_code == 409
    body = stale.json()
    assert set(body) == {"detail", "error_code", "current"}
    assert body["detail"] == CONFLICT_DETAIL == "This was changed in another tab or on another device."
    assert body["error_code"] == "edit_conflict"
    assert body["current"]["version"] == 2
    assert body["current"][field] == "SYNTH newer tab"
    assert body["current"]["id"] == created["id"]
    stored = work_db.row(TABLE_OF[kind], created["id"])
    assert stored[field] == "SYNTH newer tab"
    assert stored["version"] == 2


@each_kind
def test_keep_mine_resends_with_the_current_version(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    field = next(iter(edit))
    work_api.put(f"/{kind}/{created['id']}", json={field: "SYNTH other device", "expected_version": 1})
    conflict = work_api.put(f"/{kind}/{created['id']}", json={field: "SYNTH mine", "expected_version": 1}).json()
    kept = work_api.put(
        f"/{kind}/{created['id']}", json={field: "SYNTH mine", "expected_version": conflict["current"]["version"]}
    )
    assert kept.status_code == 200
    assert kept.json()["version"] == 3
    assert work_db.row(TABLE_OF[kind], created["id"])[field] == "SYNTH mine"


@each_kind
def test_a_retried_save_whose_first_copy_landed_is_200_not_409(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    first = work_api.put(f"/{kind}/{created['id']}", json={**edit, "expected_version": 1})
    assert first.json()["version"] == 2
    # The answer was lost on the way back, so the browser sends the very same save again.
    retry = work_api.put(f"/{kind}/{created['id']}", json={**edit, "expected_version": 1})
    assert retry.status_code == 200, retry.text
    assert retry.json()["version"] == 2  # no second bump
    updates = [call for call in work_db.calls if call[1] == "update"]
    assert len(updates) == 1


@each_kind
def test_overlap_old_frontend_without_expected_version_still_saves_and_bumps(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    response = work_api.put(f"/{kind}/{created['id']}", json=edit)
    assert response.status_code == 200
    assert response.json()["version"] == 2
    again = work_api.put(f"/{kind}/{created['id']}", json=edit)
    assert again.json()["version"] == 3


@each_kind
def test_saving_a_deleted_item_is_404_item_gone(work_api, work_db, kind):
    created = _create(work_api, kind)
    work_api.delete(f"/{kind}/{created['id']}")
    _, edit = KINDS[kind]
    response = work_api.put(f"/{kind}/{created['id']}", json={**edit, "expected_version": 1})
    assert response.status_code == 404
    assert response.json()["error_code"] == "item_gone"


@each_kind
def test_another_students_item_is_gone_and_untouched(work_api, work_db, student, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    student.id = "student-b"
    response = work_api.put(f"/{kind}/{created['id']}", json={**edit, "expected_version": 1})
    assert response.status_code == 404
    assert response.json()["error_code"] == "item_gone"
    assert "current" not in response.json()
    assert work_db.row(TABLE_OF[kind], created["id"])["version"] == 1


@each_kind
def test_the_client_cannot_set_version_create_key_or_progress_rev(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    spoof = {"version": 99, "create_key": "00000000-0000-4000-8000-000000000000", "progress_rev": 42}
    response = work_api.put(f"/{kind}/{created['id']}", json={**edit, **spoof, "expected_version": 1})
    assert response.status_code == 200
    stored = work_db.row(TABLE_OF[kind], created["id"])
    assert stored["version"] == 2
    assert stored.get("create_key") is None
    assert stored.get("progress_rev", 0) == 0


@each_kind
def test_a_save_racing_another_tab_between_read_and_write_is_refused(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    field = next(iter(edit))
    work_db.other_tab_saves(TABLE_OF[kind], created["id"], **{field: "SYNTH raced in"})
    response = work_api.put(f"/{kind}/{created['id']}", json={field: "SYNTH mine", "expected_version": 1})
    assert response.status_code == 409
    assert response.json()["current"][field] == "SYNTH raced in"
    assert work_db.row(TABLE_OF[kind], created["id"])[field] == "SYNTH raced in"


@each_kind
def test_overlap_save_racing_another_tab_wins_on_the_next_round(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    field = next(iter(edit))
    work_db.other_tab_saves(TABLE_OF[kind], created["id"], **{field: "SYNTH raced in"})
    response = work_api.put(f"/{kind}/{created['id']}", json={field: "SYNTH mine"})
    assert response.status_code == 200
    assert response.json()["version"] == 3
    assert work_db.row(TABLE_OF[kind], created["id"])[field] == "SYNTH mine"


@each_kind
def test_losing_every_round_ends_in_a_409_not_a_loop(work_api, work_db, kind):
    created = _create(work_api, kind)
    _, edit = KINDS[kind]
    field = next(iter(edit))
    work_db.other_tab_saves(TABLE_OF[kind], created["id"], times=MAX_CAS_ROUNDS, **{field: "SYNTH busy"})
    response = work_api.put(f"/{kind}/{created['id']}", json={field: "SYNTH mine"})
    assert response.status_code == 409
    assert response.json()["error_code"] == "edit_conflict"
    assert len([c for c in work_db.calls if c[1] == "update"]) == MAX_CAS_ROUNDS


# ---------- the share toggle sends expected_version too ----------


def test_share_toggle_with_a_stale_version_is_409(work_api, work_db, student):
    created = work_api.post("/notes", json=KINDS["notes"][0]).json()
    work_api.put(f"/notes/{created['id']}", json={"title": "SYNTH renamed elsewhere", "expected_version": 1})
    response = work_api.put(f"/notes/{created['id']}", json={"is_public": True, "expected_version": 1})
    assert response.status_code == 409
    assert response.json()["current"]["title"] == "SYNTH renamed elsewhere"
    assert work_db.row("notes", created["id"]).get("is_public") is False


def test_share_toggle_retry_after_it_landed_is_200(work_api, work_db, student):
    created = work_api.post("/notes", json=KINDS["notes"][0]).json()
    first = work_api.put(f"/notes/{created['id']}", json={"is_public": True, "expected_version": 1})
    assert first.status_code == 200 and first.json()["is_public"] is True
    retry = work_api.put(f"/notes/{created['id']}", json={"is_public": True, "expected_version": 1})
    assert retry.status_code == 200
    assert retry.json()["version"] == 2


def test_study_session_create_ignores_the_clients_updated_at(work_api, work_db, student):
    created = work_api.post("/study-sessions", json={"name": "Plan", "updated_at": "1999-01-01T00:00:00"}).json()
    assert not created["updated_at"].startswith("1999")
