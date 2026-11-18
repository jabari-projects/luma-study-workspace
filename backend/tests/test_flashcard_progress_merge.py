"""Studying in one tab and editing the deck in another: both are kept.

PATCH /flashcards/{id}/progress merges review progress per card and never bumps `version`.
The deck editor's PUT keeps the stored progress for each card id.
Synthetic data only, in-memory fake (tests/work_fakes.py).
"""

from __future__ import annotations

from app.edit_versions import MAX_CAS_ROUNDS
from tests.work_fakes import student, work_api, work_db  # noqa: F401

REVIEW = {"due": "2026-11-20T00:00:00+00:00", "stability": 3.1, "difficulty": 5, "elapsed_days": 0,
          "scheduled_days": 1, "learning_steps": 0, "reps": 1, "lapses": 0, "state": 1, "last_review": None}


def _deck(work_api):
    response = work_api.post(
        "/flashcards",
        json={"title": "SYNTH deck", "cards": [
            {"id": "c1", "front": "Q1", "back": "A1"},
            {"id": "c2", "front": "Q2", "back": "A2"},
        ]},
    )
    assert response.status_code == 201
    return response.json()


def test_progress_merges_per_card_and_leaves_version_alone(work_api, work_db):
    deck = _deck(work_api)
    response = work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {"c1": REVIEW, "zzz": REVIEW}})
    assert response.status_code == 200, response.text
    assert response.json() == {"version": 1, "progress_rev": 1}
    stored = work_db.row("flashcards", deck["id"])
    assert stored["cards"][0]["review"] == REVIEW
    assert stored["cards"][1]["review"] is None
    assert [card["id"] for card in stored["cards"]] == ["c1", "c2"]  # unknown ids are ignored
    assert stored["version"] == 1


def test_editor_save_keeps_progress_and_new_cards_start_fresh(work_api, work_db):
    deck = _deck(work_api)
    work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {"c1": REVIEW, "c2": REVIEW}})
    sneaky = {**REVIEW, "reps": 99}
    response = work_api.put(f"/flashcards/{deck['id']}", json={
        "expected_version": 1,
        "cards": [
            {"id": "c1", "front": "Q1 edited", "back": "A1", "review": sneaky},
            {"id": "c3", "front": "Q3", "back": "A3", "review": sneaky},
        ],
    })
    assert response.status_code == 200, response.text
    cards = {card["id"]: card for card in work_db.row("flashcards", deck["id"])["cards"]}
    assert cards["c1"]["front"] == "Q1 edited"
    assert cards["c1"]["review"] == REVIEW  # the editor never overwrites progress
    assert cards["c3"]["review"] is None
    assert "c2" not in cards  # the student removed it in the editor
    assert response.json()["version"] == 2


def test_study_tab_saves_between_the_editors_read_and_write(work_api, work_db):
    deck = _deck(work_api)
    stored_cards = work_db.row("flashcards", deck["id"])["cards"]
    studied = [{**stored_cards[0], "review": REVIEW}, stored_cards[1]]
    # Between the editor's read and its write, the study tab merges progress (progress_rev moves).
    work_db.other_tab_saves("flashcards", deck["id"], progress_rev=1, cards=studied)
    response = work_api.put(f"/flashcards/{deck['id']}", json={
        "expected_version": 1,
        "cards": [{"id": "c1", "front": "Q1 edited", "back": "A1"}, {"id": "c2", "front": "Q2", "back": "A2"}],
    })
    assert response.status_code == 200, response.text  # not a conflict: only progress moved
    stored = work_db.row("flashcards", deck["id"])
    assert stored["cards"][0]["front"] == "Q1 edited"
    assert stored["cards"][0]["review"] == REVIEW
    assert stored["version"] == 2
    assert stored["progress_rev"] == 1


def test_progress_while_the_editor_is_open_never_causes_a_conflict(work_api, work_db):
    deck = _deck(work_api)
    for _ in range(3):
        assert work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {"c2": REVIEW}}).status_code == 200
    response = work_api.put(f"/flashcards/{deck['id']}", json={"expected_version": 1, "title": "SYNTH renamed"})
    assert response.status_code == 200
    assert work_db.row("flashcards", deck["id"])["cards"][1]["review"] == REVIEW


def test_progress_that_keeps_losing_says_progress_busy(work_api, work_db):
    deck = _deck(work_api)
    row = work_db.row("flashcards", deck["id"])

    def another_study_tab_always_first(query):
        row["progress_rev"] += 1

    work_db.before_update = another_study_tab_always_first
    response = work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {"c1": REVIEW}})
    assert response.status_code == 409
    assert response.json()["error_code"] == "progress_busy"
    assert row["progress_rev"] == MAX_CAS_ROUNDS
    assert row["cards"][0]["review"] is None


def test_progress_for_a_deck_that_is_gone_or_not_yours(work_api, work_db, student):
    deck = _deck(work_api)
    student.id = "student-b"
    response = work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {"c1": REVIEW}})
    assert response.status_code == 404
    assert response.json()["error_code"] == "item_gone"
    assert work_db.row("flashcards", deck["id"])["cards"][0]["review"] is None


def test_progress_body_limits(work_api, work_db):
    deck = _deck(work_api)
    assert work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {}}).status_code == 422
    too_many = {f"c{i}": None for i in range(501)}
    assert work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": too_many}).status_code == 422
    assert work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {"x" * 65: None}}).status_code == 422


def test_overlap_old_study_page_put_keeps_the_review_it_sends(work_api, work_db):
    deck = _deck(work_api)
    response = work_api.put(f"/flashcards/{deck['id']}", json={
        "cards": [{"id": "c1", "front": "Q1", "back": "A1", "review": REVIEW}, {"id": "c2", "front": "Q2", "back": "A2"}],
    })
    assert response.status_code == 200
    assert work_db.row("flashcards", deck["id"])["cards"][0]["review"] == REVIEW


def test_a_retried_editor_save_that_already_landed_is_200(work_api, work_db):
    deck = _deck(work_api)
    body = {"expected_version": 1, "cards": [{"id": "c1", "front": "Q1 new", "back": "A1"}]}
    assert work_api.put(f"/flashcards/{deck['id']}", json=body).json()["version"] == 2
    retry = work_api.put(f"/flashcards/{deck['id']}", json=body)
    assert retry.status_code == 200
    assert retry.json()["version"] == 2


def test_editor_save_between_the_progress_read_and_write_is_kept(work_api, work_db):
    deck = _deck(work_api)
    row = work_db.row("flashcards", deck["id"])
    fired = {"n": 0}

    def editor_lands_first(query):
        if fired["n"]:
            return
        fired["n"] = 1
        # The editor tab's PUT lands between the study tab's read and write: version moves,
        # progress_rev does not.
        row["cards"] = [{**row["cards"][0], "front": "Q1 EDITED"}, row["cards"][1]]
        row["version"] = 2

    work_db.before_update = editor_lands_first
    response = work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {"c1": REVIEW}})
    assert response.status_code == 200, response.text
    assert response.json() == {"version": 2, "progress_rev": 1}
    stored = work_db.row("flashcards", deck["id"])
    assert stored["cards"][0]["front"] == "Q1 EDITED"  # the editor's words were not undone
    assert stored["cards"][0]["review"] == REVIEW  # and the progress still landed
    assert stored["version"] == 2  # progress never bumps version


def test_progress_that_keeps_losing_to_editor_saves_says_progress_busy(work_api, work_db):
    deck = _deck(work_api)
    row = work_db.row("flashcards", deck["id"])

    def an_editor_always_first(query):
        row["version"] += 1

    work_db.before_update = an_editor_always_first
    response = work_api.patch(f"/flashcards/{deck['id']}/progress", json={"reviews": {"c1": REVIEW}})
    assert response.status_code == 409
    assert response.json()["error_code"] == "progress_busy"
    assert row["progress_rev"] == 0
    assert row["cards"][0]["review"] is None
