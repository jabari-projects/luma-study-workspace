"""PR-B1: shared study sets are for signed-in students only, show a username and
nothing else about the person, and stay out of search engines (fake database only)."""

import pytest
from fastapi.testclient import TestClient

from app import main, public_search
from app.auth import get_current_user_id

from tests.test_security import FakeSupabase  # noqa: F401

VIEWER = "11111111-1111-1111-1111-111111111111"
SAM_ID = "aaaaaaaa-0000-4000-8000-000000000001"
LEE_ID = "bbbbbbbb-0000-4000-8000-000000000002"
SAMANTHA_ID = "cccccccc-0000-4000-8000-000000000003"

# The subject slugs come from the shared subject list; they say nothing about the person.
ITEM_KEYS = {"id", "study_type", "title", "preview", "tags", "subject_slug", "subtopic_slug", "username", "published_at", "created_at"}
USER_KEYS = {"username", "items"}


def _row(row_id, user_id, title, published_at, **extra):
    return {
        "id": row_id,
        "user_id": user_id,
        "title": title,
        "tags": ["science"],
        "is_public": True,
        "published_at": published_at,
        "published_by": "old_name",
        "created_at": "2026-01-01T00:00:00",
        **extra,
    }


@pytest.fixture
def db(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(main, "supabase", fake)
    monkeypatch.setattr(public_search, "get_supabase", lambda: fake)
    fake.tables["profiles"] = [
        {"user_id": SAM_ID, "username": "sam", "display_name": "Sam Real-Name", "avatar_url": "https://x.test/sam.png"},
        {"user_id": LEE_ID, "username": "lee", "display_name": "Lee Real-Name", "avatar_url": "https://x.test/lee.png"},
        {"user_id": SAMANTHA_ID, "username": "samantha", "display_name": "Samantha Q", "avatar_url": None},
    ]
    fake.tables["notes"] = [
        _row("n1", SAM_ID, "Plant cells", "2026-02-01T00:00:00", content="Cells have walls."),
        _row("n2", SAM_ID, "Private diary", "2026-02-02T00:00:00", content="secret", is_public=False),
    ]
    fake.tables["flashcards"] = [
        _row("f1", LEE_ID, "Planets", "2026-03-01T00:00:00", front="Closest planet?", back="Mercury"),
        _row("f2", SAMANTHA_ID, "Spanish words", "2026-01-15T00:00:00", front="Hello", back="Hola"),
        _row("f3", SAMANTHA_ID, "More Spanish", "2026-01-16T00:00:00", front="Cat", back="Gato"),
        _row("f4", SAMANTHA_ID, "Even more Spanish", "2026-01-17T00:00:00", front="Dog", back="Perro"),
    ]
    fake.tables["summaries"] = [
        _row("s1", LEE_ID, "Water cycle", "2026-02-15T00:00:00", content="Rain falls."),
    ]
    return fake


@pytest.fixture
def signed_in():
    main.app.dependency_overrides[get_current_user_id] = lambda: VIEWER
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(get_current_user_id, None)


@pytest.fixture
def signed_out():
    main.app.dependency_overrides.pop(get_current_user_id, None)
    return TestClient(main.app)


# ---------- signed in only ----------


@pytest.mark.parametrize("path", ["/public/topics", "/public/topics?query=plant", "/public/users?query=sam"])
def test_signed_out_visitors_get_401(db, signed_out, path):
    response = signed_out.get(path)
    assert response.status_code == 401
    assert "Plant" not in response.text and "sam" not in response.text


def test_a_bad_token_gets_401(db, signed_out):
    response = signed_out.get("/public/topics", headers={"Authorization": "Bearer not-a-real-token"})
    assert response.status_code == 401


def test_signed_in_students_can_browse(db, signed_in):
    response = signed_in.get("/public/topics")
    assert response.status_code == 200
    titles = [item["title"] for item in response.json()]
    # Newest shared first, private items never show.
    assert titles == ["Planets", "Water cycle", "Plant cells", "Even more Spanish", "More Spanish", "Spanish words"]


# ---------- username only ----------


def test_topic_results_have_exactly_the_allowed_keys(db, signed_in):
    items = signed_in.get("/public/topics").json()
    assert items
    for item in items:
        assert set(item) == ITEM_KEYS


def test_topic_results_never_carry_ids_names_or_photos(db, signed_in):
    text = signed_in.get("/public/topics").text
    for leak in (SAM_ID, LEE_ID, SAMANTHA_ID, "Real-Name", "Samantha Q", "x.test", "user_id", "display_name", "avatar_url"):
        assert leak not in text


def test_the_username_is_the_owners_current_one(db, signed_in):
    items = {item["id"]: item for item in signed_in.get("/public/topics").json()}
    assert items["n1"]["username"] == "sam"  # not the stale "old_name" snapshot
    assert items["f1"]["username"] == "lee"


def test_a_missing_profile_never_shows_part_of_the_user_id(db, signed_in):
    db.tables["profiles"] = []
    db.tables["notes"][0]["published_by"] = None
    items = {item["id"]: item for item in signed_in.get("/public/topics").json()}
    assert items["n1"]["username"] == "student"
    assert SAM_ID[:8] not in signed_in.get("/public/topics").text


def test_people_results_have_exactly_the_allowed_keys(db, signed_in):
    users = signed_in.get("/public/users", params={"query": "sam"}).json()
    assert users
    for user in users:
        assert set(user) == USER_KEYS
        for item in user["items"]:
            assert set(item) == ITEM_KEYS


def test_people_search_has_no_counts_and_no_popularity_order(db, signed_in):
    response = signed_in.get("/public/users", params={"query": "sam"})
    assert response.status_code == 200
    assert "public_count" not in response.text and "count" not in response.text
    # samantha shared 3 sets and sam shared 1: the exact name still comes first.
    assert [user["username"] for user in response.json()] == ["sam", "samantha"]


def test_people_search_matches_usernames_only_not_real_names(db, signed_in):
    assert signed_in.get("/public/users", params={"query": "Real-Name"}).json() == []
    assert signed_in.get("/public/users", params={"query": "@lee"}).json()[0]["username"] == "lee"


@pytest.mark.parametrize("query", ["", "  ", "sa", "@s"])
def test_people_search_needs_three_letters(db, signed_in, query):
    response = signed_in.get("/public/users", params={"query": query})
    assert response.status_code == 200
    assert response.json() == []


def test_people_search_only_lists_people_who_shared(db, signed_in):
    db.tables["profiles"].append({"user_id": "dddddddd-0000-4000-8000-000000000004", "username": "samuel"})
    names = [user["username"] for user in signed_in.get("/public/users", params={"query": "sam"}).json()]
    assert "samuel" not in names


# ---------- the old open user search is gone ----------


def test_old_user_search_route_is_gone(db, signed_in, signed_out):
    assert signed_out.get("/users/search", params={"query": "sam"}).status_code == 404
    assert signed_in.get("/users/search", params={"query": "sam"}).status_code == 404
    paths = {route.path for route in main.app.routes}
    assert "/users/search" not in paths


# ---------- no search engines ----------


@pytest.mark.parametrize("path", ["/health", "/robots.txt", "/public/topics", "/no-such-route", "/users/search"])
def test_every_response_says_noindex(db, signed_out, path):
    response = signed_out.get(path)
    assert response.headers.get("X-Robots-Tag") == "noindex, nofollow"


def test_signed_in_responses_say_noindex_too(db, signed_in):
    response = signed_in.get("/public/topics")
    assert response.status_code == 200
    assert response.headers.get("X-Robots-Tag") == "noindex, nofollow"


def test_cors_preflight_says_noindex(db, signed_out):
    response = signed_out.options(
        "/public/topics",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert response.headers.get("X-Robots-Tag") == "noindex, nofollow"


def test_robots_txt_disallows_everything(signed_out):
    response = signed_out.get("/robots.txt")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    lines = [line.strip() for line in response.text.splitlines() if line.strip()]
    assert lines == ["User-agent: *", "Disallow: /"]


# ---------- old names never lead to anyone ----------


def test_topic_search_does_not_match_an_old_stored_name(db, signed_in):
    # Every fixture row still carries published_by "old_name" from before a rename.
    assert signed_in.get("/public/topics", params={"query": "old_name"}).json() == []
    db.tables["notes"][0]["published_by"] = "Jane Smith"
    assert signed_in.get("/public/topics", params={"query": "jane smith"}).json() == []


def test_a_missing_profile_shows_student_not_the_old_stored_name(db, signed_in):
    db.tables["profiles"] = []
    items = {item["id"]: item for item in signed_in.get("/public/topics").json()}
    assert items["n1"]["username"] == "student"
    assert "old_name" not in signed_in.get("/public/topics").text


def test_people_search_does_not_match_an_old_stored_name(db, signed_in):
    assert signed_in.get("/public/users", params={"query": "old_name"}).json() == []


# ---------- people search finds students who shared long ago ----------


def test_people_search_finds_someone_behind_many_newer_items(db, signed_in):
    # 120 newer shared notes from other students push sam's one note out of the newest 80.
    for n in range(120):
        user_id = f"eeeeeeee-0000-4000-8000-{n:012d}"
        db.tables["profiles"].append({"user_id": user_id, "username": f"busy{n}"})
        db.tables["notes"].insert(0, _row(f"busy-{n}", user_id, f"Busy note {n}", f"2026-06-{(n % 28) + 1:02d}T00:00:00", content="x"))
    topics = [item["id"] for item in signed_in.get("/public/topics").json()]
    assert "n1" not in topics  # the topic list really is full of newer items
    users = signed_in.get("/public/users", params={"query": "sam"}).json()
    assert [user["username"] for user in users] == ["sam", "samantha"]
    assert [item["id"] for item in users[0]["items"]] == ["n1"]


def test_people_search_treats_like_wildcards_as_letters(db, signed_in):
    assert signed_in.get("/public/users", params={"query": "s%m"}).json() == []
    assert signed_in.get("/public/users", params={"query": "___"}).json() == []
    assert signed_in.get("/public/users", params={"query": "sa*"}).json() == []


# ---------- previews are plain words ----------


def test_note_previews_drop_markdown_marks(db, signed_in):
    db.tables["notes"][0]["content"] = (
        "# Plant cells\n\nPlant cells have a **cell wall** and _chloroplasts_.\n"
        "- The wall keeps it `strong`.\n> A quote\n---\nCell wall :: keeps shape\n[Read more](https://x.test/a)"
    )
    items = {item["id"]: item for item in signed_in.get("/public/topics").json()}
    assert items["n1"]["preview"] == (
        "Plant cells Plant cells have a cell wall and chloroplasts. The wall keeps it strong. "
        "A quote Cell wall - keeps shape Read more"
    )


def test_plain_text_keeps_words_with_underscores_and_math():
    assert public_search._clip("snake_case stays, 2 - 1 = 1") == "snake_case stays, 2 - 1 = 1"
