"""require_admin and require_verified_user fail closed (fake database only)."""

import pytest
from fastapi import HTTPException

from app import auth
from tests.feedback_fake import FeedbackFake


@pytest.fixture
def db(monkeypatch):
    fake = FeedbackFake(lambda: None)
    monkeypatch.setattr(auth, "get_supabase", lambda: fake)
    return fake


def test_admin_passes(db):
    row = db.user(role="admin")
    assert auth.require_admin(row["id"]) == row["id"]


@pytest.mark.parametrize("role", [None, "student", "Admin", ""])
def test_non_admin_roles_are_403(db, role):
    row = db.user(role=role)
    with pytest.raises(HTTPException) as err:
        auth.require_admin(row["id"])
    assert err.value.status_code == 403


def test_missing_users_row_is_403_not_500(db):
    with pytest.raises(HTTPException) as err:
        auth.require_admin("nobody")
    assert err.value.status_code == 403


def test_admin_read_error_is_403(db):
    db.user(role="admin", user_id="a1")
    db.fail_on.add(("users", "select"))
    with pytest.raises(HTTPException) as err:
        auth.require_admin("a1")
    assert err.value.status_code == 403


def test_verified_user_passes(db):
    row = db.user(verified=True)
    assert auth.require_verified_user(row["id"]) == row["id"]


@pytest.mark.parametrize("verified", [False, None, "true", 1])
def test_anything_but_true_is_unverified(db, verified):
    row = db.user(verified=verified)
    with pytest.raises(auth.CodedHTTPException) as err:
        auth.require_verified_user(row["id"])
    assert err.value.status_code == 403 and err.value.error_code == "email_unverified"
    assert err.value.detail == "Verify your email to answer the poll."


def test_verified_check_fails_closed(db):
    with pytest.raises(auth.CodedHTTPException):
        auth.require_verified_user("missing")
    db.user(verified=True, user_id="v1")
    db.fail_on.add(("users", "select"))
    with pytest.raises(auth.CodedHTTPException):
        auth.require_verified_user("v1")
