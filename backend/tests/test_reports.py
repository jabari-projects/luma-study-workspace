"""Reports about public content reach an admin review queue (fake database only)."""

import pytest
from fastapi.testclient import TestClient

from app import account_deletion, main, reports
from app.auth import get_current_user_id, require_admin

from tests.test_security import FakeSupabase  # noqa: F401

REPORTER = "11111111-1111-1111-1111-111111111111"
ADMIN = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def db(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(main, "supabase", fake)
    monkeypatch.setattr(reports, "get_supabase", lambda: fake)
    fake.tables["notes"] = [
        {"id": "pub-1", "title": "Public plants", "is_public": True, "user_id": "author"},
        {"id": "priv-1", "title": "Private diary", "is_public": False, "user_id": "author"},
    ]
    reports.report_user_limiter.clear()
    yield fake
    reports.report_user_limiter.clear()


@pytest.fixture
def as_user():
    def login(user_id, admin=False):
        main.app.dependency_overrides[get_current_user_id] = lambda: user_id
        if admin:
            main.app.dependency_overrides[require_admin] = lambda: user_id
        else:
            main.app.dependency_overrides.pop(require_admin, None)
        return TestClient(main.app)

    yield login
    main.app.dependency_overrides.pop(get_current_user_id, None)
    main.app.dependency_overrides.pop(require_admin, None)


def report(client, item_id="pub-1", reason="unsafe", details="Looks unsafe"):
    return client.post(
        "/public/reports",
        json={"item_type": "note", "item_id": item_id, "reason": reason, "details": details},
    )


def test_synthetic_report_reaches_the_admin_queue(db, as_user):
    r = report(as_user(REPORTER))
    assert r.status_code == 201 and r.json()["success"] is True
    queue = as_user(ADMIN, admin=True).get("/admin/reports").json()
    assert len(queue) == 1
    item = queue[0]
    assert item["item_id"] == "pub-1" and item["item_title"] == "Public plants"
    assert item["reason"] == "unsafe" and item["status"] == "open"
    assert "reporter_id" not in item  # reviewers don't need who reported


def test_admin_can_resolve_and_queue_filters_by_status(db, as_user):
    report(as_user(REPORTER))
    admin = as_user(ADMIN, admin=True)
    report_id = admin.get("/admin/reports").json()[0]["id"]
    done = admin.patch(f"/admin/reports/{report_id}", json={"status": "resolved", "reviewer_note": "Unpublished"})
    assert done.status_code == 200 and done.json()["status"] == "resolved" and done.json()["reviewed_at"]
    assert admin.get("/admin/reports").json() == []
    assert len(admin.get("/admin/reports?status=resolved").json()) == 1


def test_private_or_missing_items_cannot_be_reported(db, as_user):
    client = as_user(REPORTER)
    assert report(client, item_id="priv-1").status_code == 404
    assert report(client, item_id="nope").status_code == 404
    assert db.tables.get("content_reports", []) == []


def test_duplicate_open_reports_are_not_piled_up(db, as_user):
    client = as_user(REPORTER)
    report(client)
    report(client)
    assert len(db.tables["content_reports"]) == 1


def test_non_admins_cannot_see_the_queue(db, as_user, monkeypatch):
    client = as_user(REPORTER)
    main.app.dependency_overrides.pop(require_admin, None)

    def deny():
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="Admin access required")

    main.app.dependency_overrides[require_admin] = deny
    assert client.get("/admin/reports").status_code == 403


def test_report_limit_per_user(db, as_user):
    client = as_user(REPORTER)
    db.tables["notes"] += [{"id": f"p{i}", "title": "x", "is_public": True} for i in range(15)]
    codes = [report(client, item_id=f"p{i}").status_code for i in range(reports.REPORTS_PER_USER_PER_HOUR + 1)]
    assert codes[-1] == 429 and codes.count(201) == reports.REPORTS_PER_USER_PER_HOUR


def test_bad_reason_rejected(db, as_user):
    assert report(as_user(REPORTER), reason="i-dont-like-it").status_code == 422


def test_account_deletion_keeps_reports_without_the_name(db):
    db.user(id=REPORTER, email="r@example.com", username="r")
    db.tables["content_reports"] = [
        {"id": "rep-1", "reporter_id": REPORTER, "item_type": "note", "item_id": "pub-1", "status": "open"}
    ]
    db.tables["email_codes"] = [
        {"id": "c1", "email": "r@example.com", "purpose": "signup", "user_id": None},
        {"id": "c2", "email": "other@example.com", "purpose": "signup", "user_id": None},
    ]
    result = account_deletion.step_anonymize_reports(REPORTER, account_deletion.DeletionDeps(db=db))
    assert result.outcome == account_deletion.ANONYMIZED
    assert db.tables["content_reports"][0]["reporter_id"] is None
    pending = account_deletion.step_delete_pending_signups(REPORTER, account_deletion.DeletionDeps(db=db))
    assert pending.count == 1 and [r["id"] for r in db.tables["email_codes"]] == ["c2"]


def test_deletion_explains_every_kept_record():
    kept = account_deletion.DeletionReport().retained
    assert any("free AI limit" in line for line in kept)
    assert any("Reports you sent" in line for line in kept)
