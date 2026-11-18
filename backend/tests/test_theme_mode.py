"""PR-B3: the saved theme is Light, Dark or Automatic (fake database only).

New saves must be one of the three. Profiles saved before this check keep
loading: an empty theme stays empty and anything else reads as Light.
"""

import pytest
from fastapi.testclient import TestClient

from app import main
from app.auth import get_current_user, get_current_user_id

from tests.test_security import FakeSupabase

OWNER_ID = "theme-owner-1"


@pytest.fixture
def db(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(main, "supabase", fake)
    fake.user(id=OWNER_ID, username="theme_owner", password="x")
    fake.tables["profiles"] = [{"user_id": OWNER_ID, "username": "theme_owner", "theme_mode": None}]
    return fake


@pytest.fixture
def api(db):
    main.app.dependency_overrides[get_current_user_id] = lambda: OWNER_ID
    main.app.dependency_overrides[get_current_user] = lambda: {"id": OWNER_ID}
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(get_current_user_id, None)
        main.app.dependency_overrides.pop(get_current_user, None)


def saved_mode(db):
    return db.tables["profiles"][0].get("theme_mode")


# ---------- saving ----------


@pytest.mark.parametrize("mode", ["light", "dark", "auto"])
def test_each_choice_saves_and_comes_back(api, db, mode):
    response = api.put("/me/profile", json={"theme_mode": mode})
    assert response.status_code == 200, response.text
    assert response.json()["theme_mode"] == mode
    assert saved_mode(db) == mode
    assert api.get("/me/profile").json()["theme_mode"] == mode


@pytest.mark.parametrize("bad", ["purple", "", "Dark", "AUTO", " light", "system", 1, True, ["dark"], {"mode": "dark"}])
def test_anything_else_is_turned_away_and_not_saved(api, db, bad):
    db.tables["profiles"][0]["theme_mode"] = "dark"
    response = api.put("/me/profile", json={"theme_mode": bad})
    assert response.status_code == 422
    assert saved_mode(db) == "dark"
    assert not any(call[0] == "profiles" and call[1] == "update" for call in db.calls)


def test_a_bad_theme_does_not_save_the_other_fields_either(api, db):
    response = api.put("/me/profile", json={"theme_mode": "purple", "theme_color": "#0f766e"})
    assert response.status_code == 422
    assert "theme_color" not in db.tables["profiles"][0]


def test_the_error_does_not_echo_what_was_sent(api, db):
    response = api.put("/me/profile", json={"theme_mode": "purple-secret-value"})
    assert response.status_code == 422
    assert "purple-secret-value" not in response.text


def test_signed_out_with_a_bad_theme_gets_401_not_422(db):
    # Sign-in is checked before the body, so a stranger learns nothing about valid themes.
    db.tables["profiles"][0]["theme_mode"] = "dark"
    response = TestClient(main.app).put("/me/profile", json={"theme_mode": "purple"})
    assert response.status_code == 401
    assert saved_mode(db) == "dark"
    assert not any(call[0] == "profiles" and call[1] == "update" for call in db.calls)


def test_leaving_the_theme_out_keeps_the_saved_one(api, db):
    db.tables["profiles"][0]["theme_mode"] = "auto"
    response = api.put("/me/profile", json={"theme_color": "#0f766e"})
    assert response.status_code == 200, response.text
    assert response.json()["theme_mode"] == "auto"
    assert saved_mode(db) == "auto"


def test_sending_null_keeps_the_saved_one(api, db):
    db.tables["profiles"][0]["theme_mode"] = "dark"
    response = api.put("/me/profile", json={"theme_mode": None})
    assert response.status_code == 200, response.text
    assert response.json()["theme_mode"] == "dark"
    assert saved_mode(db) == "dark"


# ---------- older profiles keep loading ----------


def test_an_empty_theme_stays_empty(api, db):
    # Empty means Light in the app. It must not turn into Automatic.
    response = api.get("/me/profile")
    assert response.status_code == 200, response.text
    assert response.json()["theme_mode"] is None


@pytest.mark.parametrize("stored", ["purple", "", "Dark", "system", "night"])
def test_an_unknown_saved_theme_reads_as_light(api, db, stored):
    db.tables["profiles"][0]["theme_mode"] = stored
    response = api.get("/me/profile")
    assert response.status_code == 200, response.text
    assert response.json()["theme_mode"] == "light"
    # Reading never rewrites the student's row.
    assert saved_mode(db) == stored


def test_saving_something_else_still_works_with_an_unknown_saved_theme(api, db):
    db.tables["profiles"][0]["theme_mode"] = "purple"
    response = api.put("/me/profile", json={"display_name": "Robin"})
    assert response.status_code == 200, response.text
    assert response.json()["theme_mode"] == "light"
    assert response.json()["display_name"] == "Robin"


def test_fixing_an_unknown_saved_theme(api, db):
    db.tables["profiles"][0]["theme_mode"] = "purple"
    response = api.put("/me/profile", json={"theme_mode": "auto"})
    assert response.status_code == 200, response.text
    assert saved_mode(db) == "auto"
    assert api.get("/me/profile").json()["theme_mode"] == "auto"


def test_the_shared_profile_builder_reads_unknown_as_light(db):
    db.tables["profiles"][0]["theme_mode"] = "purple"
    assert main.build_profile_response(OWNER_ID)["theme_mode"] == "light"
    db.tables["profiles"][0]["theme_mode"] = None
    assert main.build_profile_response(OWNER_ID)["theme_mode"] is None


def test_new_profiles_still_start_without_a_theme(db):
    # The default for new accounts is unchanged (an open owner question).
    row = main.create_profile("brand-new-user", "new_student")
    assert "theme_mode" not in row or row["theme_mode"] is None


@pytest.mark.parametrize("value, expected", [(None, None), ("light", "light"), ("dark", "dark"), ("auto", "auto"), ("purple", "light"), (3, "light")])
def test_read_theme_mode(value, expected):
    assert main.read_theme_mode(value) == expected
