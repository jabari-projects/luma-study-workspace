"""Subjects on notes, decks and summaries, and GET /subjects (fake database, synthetic data)."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app import main, maintenance, subjects
from app.edit_versions import CONFLICT_DETAIL
from tests.work_fakes import KINDS, TABLE_OF, student, work_api, work_db  # noqa: F401

CONTENT_KINDS = ["notes", "summaries", "flashcards"]
each_kind = pytest.mark.parametrize("kind", CONTENT_KINDS)


def _create(work_api, kind, **extra):
    body, _ = KINDS[kind]
    response = work_api.post(f"/{kind}", json={**body, **extra})
    assert response.status_code == 201, response.text
    return response.json()


# ---------- GET /subjects ----------


def test_subjects_list_needs_no_sign_in_and_has_an_etag():
    client = TestClient(main.app)
    response = client.get("/subjects")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"version", "groups", "subjects"}
    assert len(body["subjects"]) == 67
    assert response.headers["etag"] == f'"{subjects.SUBJECTS_ETAG}"'
    assert "max-age=86400" in response.headers["cache-control"]


def test_subjects_list_answers_304_when_the_browser_has_it():
    client = TestClient(main.app)
    etag = client.get("/subjects").headers["etag"]
    again = client.get("/subjects", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""
    assert client.get("/subjects", headers={"If-None-Match": '"old"'}).status_code == 200


def test_subjects_list_stays_open_during_maintenance():
    assert maintenance.classify("GET", "/subjects")[0] == maintenance.ALWAYS_OPEN


# ---------- create ----------


@each_kind
def test_create_with_a_subject_and_subtopic_stores_both(work_api, work_db, kind):
    created = _create(work_api, kind, subject_slug="math", subtopic_slug="algebra")
    assert (created["subject_slug"], created["subtopic_slug"]) == ("math", "algebra")
    stored = work_db.row(TABLE_OF[kind], created["id"])
    assert (stored["subject_slug"], stored["subtopic_slug"]) == ("math", "algebra")
    assert work_api.get(f"/{kind}/{created['id']}").json()["subject_slug"] == "math"


@each_kind
def test_create_from_an_old_website_has_no_subject_and_sends_no_subject_columns(work_api, work_db, kind):
    created = _create(work_api, kind)
    assert created["subject_slug"] is None and created["subtopic_slug"] is None
    insert = next(call for call in work_db.calls if call[1] == "insert")
    assert "subject_slug" not in insert[3] and "subtopic_slug" not in insert[3]


@each_kind
@pytest.mark.parametrize(
    "fields, message",
    [
        ({"subject_slug": "not-a-subject"}, "Pick a subject from the list."),
        ({"subtopic_slug": "algebra"}, "Pick a subject first."),
        ({"subject_slug": "biology", "subtopic_slug": "algebra"}, "Pick a subtopic from the list for this subject."),
    ],
)
def test_create_with_a_bad_subject_is_422_with_a_plain_message(work_api, work_db, kind, fields, message):
    body, _ = KINDS[kind]
    response = work_api.post(f"/{kind}", json={**body, **fields})
    assert response.status_code == 422
    assert response.json()["detail"] == message
    assert work_db.rows(TABLE_OF[kind]) == []


@each_kind
def test_a_slug_over_40_letters_is_refused(work_api, kind):
    body, _ = KINDS[kind]
    assert work_api.post(f"/{kind}", json={**body, "subject_slug": "a" * 41}).status_code == 422


@each_kind
def test_a_retried_create_returns_the_first_row_with_its_subject(work_api, work_db, kind):
    key = str(uuid.uuid4())
    body, _ = KINDS[kind]
    sent = {**body, "subject_slug": "biology", "subtopic_slug": "cells"}
    first = work_api.post(f"/{kind}", json=sent, headers={"Idempotency-Key": key})
    retry = work_api.post(f"/{kind}", json=sent, headers={"Idempotency-Key": key})
    assert first.status_code == 201 and retry.status_code == 200
    assert retry.headers.get("Idempotent-Replay") == "true"
    assert retry.json()["id"] == first.json()["id"]
    assert retry.json()["subtopic_slug"] == "cells"
    assert len(work_db.rows(TABLE_OF[kind])) == 1


# ---------- update ----------


@each_kind
def test_update_with_both_stores_both_and_null_clears(work_api, work_db, kind):
    created = _create(work_api, kind)
    saved = work_api.put(f"/{kind}/{created['id']}", json={"subject_slug": "spanish", "subtopic_slug": "verbs", "expected_version": 1})
    assert saved.status_code == 200, saved.text
    assert (saved.json()["subject_slug"], saved.json()["subtopic_slug"]) == ("spanish", "verbs")
    cleared = work_api.put(f"/{kind}/{created['id']}", json={"subject_slug": None, "subtopic_slug": None, "expected_version": 2})
    assert cleared.status_code == 200
    stored = work_db.row(TABLE_OF[kind], created["id"])
    assert stored["subject_slug"] is None and stored["subtopic_slug"] is None


@each_kind
def test_update_with_only_a_subject_clears_the_old_subtopic(work_api, work_db, kind):
    created = _create(work_api, kind, subject_slug="math", subtopic_slug="algebra")
    response = work_api.put(f"/{kind}/{created['id']}", json={"subject_slug": "biology", "expected_version": 1})
    assert response.status_code == 200
    stored = work_db.row(TABLE_OF[kind], created["id"])
    assert (stored["subject_slug"], stored["subtopic_slug"]) == ("biology", None)


@each_kind
def test_update_with_only_a_subtopic_is_checked_against_the_stored_subject(work_api, work_db, kind):
    created = _create(work_api, kind, subject_slug="math")
    ok = work_api.put(f"/{kind}/{created['id']}", json={"subtopic_slug": "geometry", "expected_version": 1})
    assert ok.status_code == 200
    assert work_db.row(TABLE_OF[kind], created["id"])["subtopic_slug"] == "geometry"
    wrong = work_api.put(f"/{kind}/{created['id']}", json={"subtopic_slug": "cells", "expected_version": 2})
    assert wrong.status_code == 422
    assert wrong.json()["detail"] == "Pick a subtopic from the list for this subject."
    assert work_db.row(TABLE_OF[kind], created["id"])["version"] == 2


@each_kind
def test_a_subtopic_alone_on_an_item_with_no_subject_is_refused(work_api, kind):
    created = _create(work_api, kind)
    response = work_api.put(f"/{kind}/{created['id']}", json={"subtopic_slug": "algebra", "expected_version": 1})
    assert response.status_code == 422
    assert response.json()["detail"] == "Pick a subject first."


@each_kind
def test_update_with_an_unknown_subject_is_422(work_api, work_db, kind):
    created = _create(work_api, kind)
    response = work_api.put(f"/{kind}/{created['id']}", json={"subject_slug": "astrology", "expected_version": 1})
    assert response.status_code == 422
    assert response.json()["detail"] == "Pick a subject from the list."
    assert work_db.row(TABLE_OF[kind], created["id"]).get("subject_slug") is None


@each_kind
def test_an_old_website_update_leaves_the_subject_alone(work_api, work_db, kind):
    created = _create(work_api, kind, subject_slug="math", subtopic_slug="algebra")
    _, edit = KINDS[kind]
    response = work_api.put(f"/{kind}/{created['id']}", json={**edit, "expected_version": 1})
    assert response.status_code == 200
    stored = work_db.row(TABLE_OF[kind], created["id"])
    assert (stored["subject_slug"], stored["subtopic_slug"]) == ("math", "algebra")


@each_kind
def test_a_retried_subject_save_that_already_landed_is_recognised(work_api, kind):
    created = _create(work_api, kind)
    body = {"subject_slug": "chemistry", "subtopic_slug": "atoms", "expected_version": 1}
    first = work_api.put(f"/{kind}/{created['id']}", json=body)
    retry = work_api.put(f"/{kind}/{created['id']}", json=body)
    assert first.status_code == 200 and retry.status_code == 200
    assert retry.json()["version"] == 2


@each_kind
def test_a_stale_subject_save_gets_409(work_api, kind):
    created = _create(work_api, kind)
    assert work_api.put(f"/{kind}/{created['id']}", json={"subject_slug": "physics", "expected_version": 1}).status_code == 200
    stale = work_api.put(f"/{kind}/{created['id']}", json={"subject_slug": "music", "expected_version": 1})
    assert stale.status_code == 409
    assert stale.json()["detail"] == CONFLICT_DETAIL
    assert stale.json()["current"]["subject_slug"] == "physics"


def test_a_subject_rides_along_with_sharing(work_api, work_db):
    created = _create(work_api, "flashcards")
    response = work_api.put(
        f"/flashcards/{created['id']}",
        json={"is_public": True, "subject_slug": "spanish", "subtopic_slug": "vocabulary", "expected_version": 1},
    )
    assert response.status_code == 200
    stored = work_db.row("flashcards", created["id"])
    assert stored["is_public"] is True and stored["subject_slug"] == "spanish"
