"""GET /public/search: shared items for words, a subject, a subtopic and a type, with counts.

Fake database only (tests/public_search_fake.py stands in for the SQL function; the real one is
proven by backend/scripts/check_subjects_migration.mjs). Synthetic data only.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main, public_search
from app.auth import get_current_user_id
from tests.test_security import FakeSupabase

VIEWER = "11111111-1111-1111-1111-111111111111"
SAM = "aaaaaaaa-0000-4000-8000-000000000001"
LEE = "bbbbbbbb-0000-4000-8000-000000000002"

ITEM_KEYS = {"id", "study_type", "title", "preview", "tags", "subject_slug", "subtopic_slug", "username", "published_at", "created_at"}
ANSWER_KEYS = {"items", "total", "next_offset", "facets"}


def _row(row_id, owner, title, day, subject=None, subtopic=None, **extra):
    return {
        "id": row_id,
        "user_id": owner,
        "title": title,
        "tags": [],
        "is_public": True,
        "published_at": f"2026-01-{day:02d}T00:00:00",
        "published_by": "old_name",
        "created_at": "2026-01-01T00:00:00",
        "subject_slug": subject,
        "subtopic_slug": subtopic,
        **extra,
    }


@pytest.fixture
def db(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(main, "supabase", fake)
    monkeypatch.setattr(public_search, "get_supabase", lambda: fake)
    fake.tables["profiles"] = [
        {"user_id": SAM, "username": "sam", "display_name": "Sam Real-Name", "avatar_url": "https://x.test/a.png"},
        {"user_id": LEE, "username": "lee", "display_name": "Lee Real-Name", "avatar_url": None},
    ]
    notes, decks, summaries = [], [], []
    # 12 math items (8 algebra, 4 geometry), 6 biology, 4 with no subject, across 3 types.
    for n in range(12):
        sub = "algebra" if n < 8 else "geometry"
        words = "what is 1+1" if n % 4 == 0 else "plain words"
        if n % 3 == 0:
            decks.append(_row(f"m{n}", SAM, f"Math deck {n}", n + 1, "math", sub, front=f"Card {n}", back="x",
                              cards=[{"id": "a", "front": f"Card {n}", "back": "x"}, {"id": "b", "front": words, "back": "2"}]))
        elif n % 3 == 1:
            notes.append(_row(f"m{n}", LEE, f"Math note {n}", n + 1, "math", sub, content=words))
        else:
            summaries.append(_row(f"m{n}", SAM, f"Math summary {n}", n + 1, "math", sub, content=words))
    for n in range(6):
        notes.append(_row(f"b{n}", LEE, f"Cells {n}", n + 1, "biology", "cells", content="Cells have walls."))
    for n in range(4):
        notes.append(_row(f"x{n}", SAM, f"Loose {n}", n + 1, content="SYNTH 50% off" if n == 0 else "free words"))
    notes.append(_row("private", SAM, "Private 1+1", 28, "math", "algebra", content="1+1", is_public=False))
    notes.append(_row("blank", SAM, "  ", 28, "math", "algebra", content="1+1"))
    fake.tables.update({"notes": notes, "flashcards": decks, "summaries": summaries})
    return fake


@pytest.fixture
def signed_in():
    main.app.dependency_overrides[get_current_user_id] = lambda: VIEWER
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(get_current_user_id, None)


def _search(client, **params):
    response = client.get("/public/search", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _counts(entries, key="slug"):
    return {entry[key]: entry["count"] for entry in entries}


def test_signed_out_visitors_get_401(db):
    main.app.dependency_overrides.pop(get_current_user_id, None)
    assert TestClient(main.app).get("/public/search").status_code == 401


def test_the_answer_has_exactly_the_documented_keys(db, signed_in):
    body = _search(signed_in)
    assert set(body) == ANSWER_KEYS
    assert set(body["facets"]) == {"subjects", "subtopics", "types"}
    assert body["items"] and all(set(item) == ITEM_KEYS for item in body["items"])
    assert body["total"] == 22
    assert body["next_offset"] is None


def test_items_show_the_current_username_only_never_an_id_or_old_name(db, signed_in):
    response = signed_in.get("/public/search")
    text = response.text
    assert SAM not in text and LEE not in text and SAM[:8] not in text
    assert "old_name" not in text and "Real-Name" not in text and "x.test" not in text
    assert {item["username"] for item in response.json()["items"]} == {"sam", "lee"}


def test_private_items_and_blank_titles_never_show(db, signed_in):
    ids = {item["id"] for item in _search(signed_in, q="1+1")["items"]}
    assert "private" not in ids and "blank" not in ids


def test_words_find_every_card_not_only_the_first(db, signed_in):
    body = _search(signed_in, q="1+1")
    assert {item["id"] for item in body["items"]} == {"m0", "m4", "m8"}
    assert any(item["study_type"] == "flashcards" for item in body["items"])


def test_narrowing_by_subject_then_subtopic_then_type(db, signed_in):
    everything = _search(signed_in)
    assert _counts(everything["facets"]["subjects"]) == {"math": 12, "biology": 6, None: 4}
    assert everything["facets"]["subtopics"] == []
    assert sum(_counts(everything["facets"]["types"], "type").values()) == 22

    math = _search(signed_in, subject="math")
    assert math["total"] == 12
    # The other subjects stay in view, so a student can switch.
    assert _counts(math["facets"]["subjects"]) == {"math": 12, "biology": 6, None: 4}
    assert _counts(math["facets"]["subtopics"]) == {"algebra": 8, "geometry": 4}

    algebra = _search(signed_in, subject="math", subtopic="algebra")
    assert algebra["total"] == 8
    assert _counts(algebra["facets"]["subtopics"]) == {"algebra": 8, "geometry": 4}
    types = _counts(algebra["facets"]["types"], "type")
    assert sum(types.values()) == 8

    decks = _search(signed_in, subject="math", subtopic="algebra", type="flashcards")
    assert decks["total"] == types["flashcards"]
    assert all(item["study_type"] == "flashcards" for item in decks["items"])
    # The type counts ignore the chosen type, so the other types can still be picked.
    assert _counts(decks["facets"]["types"], "type") == types


def test_words_and_filters_combine(db, signed_in):
    body = _search(signed_in, q="1+1", subject="math", type="note")
    assert {item["id"] for item in body["items"]} == {"m4"}
    assert body["total"] == 1


def test_zero_counts_are_left_out(db, signed_in):
    body = _search(signed_in, subject="biology")
    assert _counts(body["facets"]["subtopics"]) == {"cells": 6}
    assert _counts(body["facets"]["types"], "type") == {"note": 6}


def test_words_that_name_a_subject_find_items_in_it(db, signed_in):
    # "Algebra" is in no title or text, but it is a subtopic name.
    body = _search(signed_in, q="Algebra")
    assert body["total"] == 8
    assert {item["subtopic_slug"] for item in body["items"]} == {"algebra"}


def test_like_wildcards_are_escaped_before_they_reach_the_database(db, signed_in):
    body = _search(signed_in, q="50%")
    assert [item["id"] for item in body["items"]] == ["x0"]
    _search(signed_in, q="50%_\\")
    name, params = db.rpc_calls[-1]
    assert name == "public_study_search"
    assert params["p_pattern"] == "%50\\%\\_\\\\%"
    assert _search(signed_in, q="__")["total"] == 0


def test_a_leading_hash_is_dropped(db, signed_in):
    _search(signed_in, q="#cells")
    assert db.rpc_calls[-1][1]["p_pattern"] == "%cells%"


@pytest.mark.parametrize(
    "params",
    [{"subject": "astrology"}, {"subject": "math", "subtopic": "cells"}, {"subtopic": "algebra"}],
)
def test_an_unknown_subject_or_subtopic_is_422(db, signed_in, params):
    response = signed_in.get("/public/search", params=params)
    assert response.status_code == 422
    assert response.json() == {"detail": "That subject isn't on the list.", "error_code": "unknown_subject"}


@pytest.mark.parametrize(
    "params",
    [{"type": "quiz"}, {"q": "x" * 81}, {"offset": 401}, {"offset": -1}],
)
def test_bad_parameters_are_422(db, signed_in, params):
    assert signed_in.get("/public/search", params=params).status_code == 422


def test_paging(db, signed_in, monkeypatch):
    monkeypatch.setattr(public_search, "PAGE_SIZE", 10)
    first = _search(signed_in)
    assert len(first["items"]) == 10 and first["next_offset"] == 10
    second = _search(signed_in, offset=10)
    third = _search(signed_in, offset=20)
    assert third["next_offset"] is None and len(third["items"]) == 2
    ids = [item["id"] for page in (first, second, third) for item in page["items"]]
    assert len(ids) == len(set(ids)) == 22


def test_items_are_newest_shared_first(db, signed_in):
    dates = [item["published_at"] for item in _search(signed_in)["items"]]
    assert dates == sorted(dates, reverse=True)


def test_counts_are_never_per_person(db, signed_in):
    text = signed_in.get("/public/search").text
    assert "sam" not in text.split('"facets"')[1] and "lee" not in text.split('"facets"')[1]


def test_old_topics_route_is_the_first_page_with_subject_fields(db, signed_in):
    items = signed_in.get("/public/topics", params={"query": "1+1"}).json()
    assert {item["id"] for item in items} == {"m0", "m4", "m8"}
    assert all(set(item) == ITEM_KEYS for item in items)


def test_people_search_uses_the_same_search_for_those_owners(db, signed_in):
    users = signed_in.get("/public/users", params={"query": "lee"}).json()
    assert [user["username"] for user in users] == ["lee"]
    assert all(set(item) == ITEM_KEYS for item in users[0]["items"])
    assert {item["username"] for item in users[0]["items"]} == {"lee"}
    assert db.rpc_calls[-1][1]["p_user_ids"] == [LEE]
