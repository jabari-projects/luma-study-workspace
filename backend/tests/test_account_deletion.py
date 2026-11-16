"""Account deletion: order, partial failure, retry, storage paging, Stripe, sessions.

Everything here is fake and in-memory: no Supabase, Stripe or network.
"""

from __future__ import annotations

import copy
import logging
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import account_deletion as ad
from app import auth as auth_module
from app import main
from app.auth import create_access_token

USER = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
USER_EMAIL = "student.one@example.test"
SYNTHETIC_HASH = "synthetic-credential-hash-for-tests"  # not a real password or hash


# ---------- fake Supabase ----------

class Resp:
    def __init__(self, data):
        self.data = data


class Query:
    def __init__(self, db, table):
        self.db = db
        self.table = table
        self.op = "select"
        self.filters: list[tuple[str, object]] = []
        self.values = None
        self.single = False
        self.max_rows = None

    def select(self, *_args, **_kwargs):
        self.op = "select"
        return self

    def delete(self):
        self.op = "delete"
        return self

    def update(self, values):
        self.op = "update"
        self.values = values
        return self

    def upsert(self, values, on_conflict=None):
        self.op = "upsert"
        self.values = values
        self.conflict = on_conflict
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def limit(self, count):
        self.max_rows = count
        return self

    def order(self, *_args, **_kwargs):
        return self

    def maybe_single(self):
        self.single = True
        return self

    def _match(self, row):
        return all(row.get(col) == val for col, val in self.filters)

    def execute(self):
        self.db.calls.append((self.op, self.table))
        self.db.maybe_fail(self.op, self.table)
        if self.table not in self.db.tables:
            raise RuntimeError("PGRST205 Could not find the table")
        rows = self.db.tables[self.table]
        matched = [row for row in rows if self._match(row)]
        if self.op == "upsert":
            key = self.conflict
            existing = [row for row in rows if row.get(key) == self.values.get(key)]
            if existing:
                existing[0].update(copy.deepcopy(self.values))
                return Resp([copy.deepcopy(existing[0])])
            rows.append(copy.deepcopy(self.values))
            return Resp([copy.deepcopy(self.values)])
        if self.op == "delete":
            self.db.tables[self.table] = [row for row in rows if not self._match(row)]
            if self.table == "users":
                # billing_* rows reference users(id) on delete cascade.
                gone = {row.get("id") for row in matched}
                for billing in ("billing_accounts", "billing_subscriptions"):
                    if billing in self.db.tables:
                        self.db.tables[billing] = [r for r in self.db.tables[billing] if r.get("user_id") not in gone]
            return Resp([copy.deepcopy(r) for r in matched])
        if self.op == "update":
            for row in matched:
                row.update(self.values)
            return Resp([copy.deepcopy(r) for r in matched])
        if self.max_rows is not None:
            matched = matched[: self.max_rows]
        if self.single:
            return Resp(copy.deepcopy(matched[0])) if matched else None
        return Resp([copy.deepcopy(r) for r in matched])


class Bucket:
    def __init__(self, db, name):
        self.db = db
        self.name = name

    def list(self, path=None, options=None):
        options = options or {}
        self.db.maybe_fail("storage_list", self.name)
        limit = int(options.get("limit", 100))
        offset = int(options.get("offset", 0))
        self.db.list_calls.append((self.name, limit, offset))
        prefix = f"{path}/" if path else ""
        files, folders = [], set()
        for key in sorted(self.db.storage[self.name]):
            if not key.startswith(prefix):
                continue
            rest = key[len(prefix):]
            if "/" in rest:
                folders.add(rest.split("/", 1)[0])
            else:
                files.append({"name": rest, "id": f"obj-{len(files)}", "metadata": {"size": 1}})
        entries = [{"name": f, "id": None, "metadata": None} for f in sorted(folders)] + files
        return entries[offset: offset + limit]

    def remove(self, paths):
        self.db.maybe_fail("storage_remove", self.name)
        assert len(paths) <= self.db.page_size
        removed = []
        for p in paths:
            if p in self.db.storage[self.name]:
                self.db.storage[self.name].discard(p)
                removed.append({"name": p})
        return removed


class FakeDB:
    def __init__(self, page_size=2):
        self.page_size = page_size
        self.calls: list[tuple[str, str]] = []
        self.list_calls: list = []
        self.failures: dict[tuple[str, str], int] = {}
        self.tables = {
            "users": [
                {"id": USER, "email": USER_EMAIL, "username": "student_one", "password": SYNTHETIC_HASH,
                 "password_reset_token": "hashed-reset", "email_verification_token": "hashed-verify"},
                {"id": OTHER, "email": "other@example.test", "username": "other", "password": SYNTHETIC_HASH},
            ],
            "profiles": [
                {"user_id": USER, "subscription_status": "premium", "avatar_url": "x"},
                {"user_id": OTHER, "subscription_status": "free"},
            ],
            "notifications": [
                {"id": "n1", "user_id": USER, "actor_user_id": None},
                {"id": "n2", "user_id": OTHER, "actor_user_id": USER},
                {"id": "n3", "user_id": OTHER, "actor_user_id": None},
            ],
        }
        # Verified Stripe links (billing_schema.sql). Ownership comes only from here.
        self.tables["billing_accounts"] = [
            {"user_id": USER, "stripe_customer_id": "cus_mine"},
            {"user_id": OTHER, "stripe_customer_id": "cus_other"},
        ]
        self.tables["billing_subscriptions"] = [
            {"stripe_subscription_id": "sub_mine", "user_id": USER, "stripe_customer_id": "cus_mine", "status": "active"},
            {"stripe_subscription_id": "sub_old", "user_id": USER, "stripe_customer_id": "cus_mine", "status": "canceled"},
            {"stripe_subscription_id": "sub_other", "user_id": OTHER, "stripe_customer_id": "cus_other", "status": "active"},
        ]
        for table in ("ai_usage", "analytics_events", "flashcards", "notes", "study_sessions", "summaries"):
            self.tables[table] = [
                {"id": f"{table}-a", "user_id": USER, "content": "secret study text"},
                {"id": f"{table}-b", "user_id": USER, "content": "more"},
                {"id": f"{table}-c", "user_id": OTHER, "content": "keep me"},
            ]
        # "transcripts" deliberately missing: a table never created in that project.
        self.storage = {
            "avatars": {
                f"{USER}/a.png", f"{USER}/My Holiday Photo (1).JPG", f"{USER}/b.webp",
                f"{USER}/old/legacy name.png", f"{USER}/c.png",
                f"{OTHER}/keep.png",
            },
            "themes": {
                f"themes/{USER}/t1.png", f"themes/{USER}/weird name #2.jpeg",
                f"themes/{OTHER}/keep.png",
            },
        }
        self.storage_api = SimpleNamespace(from_=lambda name: Bucket(self, name))
        self.auth = SimpleNamespace(get_user=self._auth_get_user)

    @property
    def storage_ns(self):
        return self.storage_api

    def _auth_get_user(self, _token):
        raise RuntimeError("no supabase auth in tests")

    def fail(self, op, target, times=1):
        self.failures[(op, target)] = times

    def maybe_fail(self, op, target):
        left = self.failures.get((op, target), 0)
        if left:
            self.failures[(op, target)] = left - 1
            raise RuntimeError(f"simulated outage for {target} at {USER_EMAIL}")

    def table(self, name):
        return Query(self, name)

    def user_rows(self, uid):
        return {t: [r for r in rows if r.get("user_id") == uid or (t == "users" and r.get("id") == uid)]
                for t, rows in self.tables.items()}


class DBWrapper:
    """Expose .table() and .storage like the supabase client."""

    def __init__(self, fake: FakeDB):
        self.fake = fake
        self.storage = fake.storage_api
        self.auth = fake.auth

    def table(self, name):
        return self.fake.table(name)


# ---------- fake Stripe ----------

class FakeStripe:
    """Subscriptions keyed by id, each on a customer, with optional luma_user_id metadata.

    There is deliberately no Checkout Session listing: deletion must find
    subscriptions by linked id, never by email.
    """

    def __init__(self):
        self.calls: list = []
        self.fail_next: str | None = None
        self.subscriptions = {"sub_mine": "active", "sub_old": "canceled", "sub_other": "active"}
        self.customers = {"sub_mine": "cus_mine", "sub_old": "cus_mine", "sub_other": "cus_other"}
        self.metadata = {"sub_mine": {"luma_user_id": USER}, "sub_old": {}, "sub_other": {"luma_user_id": OTHER}}
        stripe_self = self

        class Subscription:
            @staticmethod
            def list(**kwargs):
                stripe_self._check("list", kwargs)
                assert kwargs.get("status") == "all"
                found = [
                    {"id": sid, "status": status, "customer": stripe_self.customers.get(sid),
                     "metadata": stripe_self.metadata.get(sid, {})}
                    for sid, status in stripe_self.subscriptions.items()
                    if stripe_self.customers.get(sid) == kwargs.get("customer")
                ]
                return SimpleNamespace(auto_paging_iter=lambda: iter(found))

            @staticmethod
            def retrieve(sub_id, **kwargs):
                stripe_self._check("retrieve", kwargs)
                return {"id": sub_id, "status": stripe_self.subscriptions[sub_id],
                        "customer": stripe_self.customers.get(sub_id),
                        "metadata": stripe_self.metadata.get(sub_id, {})}

            @staticmethod
            def cancel(sub_id, **kwargs):
                stripe_self._check("cancel", kwargs)
                stripe_self.calls.append(("cancel", sub_id))
                stripe_self.subscriptions[sub_id] = "canceled"
                return {"id": sub_id, "status": "canceled"}

        self.Subscription = Subscription

    def _check(self, name, kwargs):
        assert kwargs.get("api_key") == "sk_test_fake"
        if self.fail_next == name:
            self.fail_next = None
            raise RuntimeError("stripe unavailable")


def make_deps(fake, stripe=None, cleared=None):
    return ad.DeletionDeps(
        db=DBWrapper(fake),
        stripe=stripe,
        stripe_secret_key="sk_test_fake" if stripe else None,
        clear_memory=(lambda uid: cleared.append(uid)) if cleared is not None else None,
        storage_page_size=fake.page_size,
    )


def outcomes(report):
    return {s.name: s.outcome for s in report.steps}


# ---------- unit tests ----------

def test_happy_path_deletes_only_this_user_and_users_row_last():
    fake = FakeDB()
    stripe = FakeStripe()
    cleared: list = []
    report = ad.delete_account_data(USER, make_deps(fake, stripe, cleared))

    assert report.succeeded, outcomes(report)
    rows = fake.user_rows(USER)
    assert all(not r for r in rows.values()), rows
    # Other student untouched (except the anonymized actor reference).
    other = fake.user_rows(OTHER)
    assert len(other["users"]) == 1 and len(other["profiles"]) == 1 and len(other["notes"]) == 1
    assert len(other["notifications"]) == 2
    assert all(n["actor_user_id"] is None for n in fake.tables["notifications"])
    # Storage removed by prefix, including odd names and nested folders.
    assert fake.storage["avatars"] == {f"{OTHER}/keep.png"}
    assert fake.storage["themes"] == {f"themes/{OTHER}/keep.png"}
    # Only this user's active subscription canceled.
    assert stripe.calls == [("cancel", "sub_mine")]
    assert stripe.subscriptions["sub_other"] == "active"
    # users delete is the last DB write.
    writes = [c for c in fake.calls if c[0] in ("delete", "update")]
    assert writes[-1] == ("delete", "users")
    assert writes[-2] == ("delete", "profiles")
    assert cleared == [USER]
    out = outcomes(report)
    assert out["cancel_subscription"] == ad.RETAINED
    assert out["notifications_actor"] == ad.ANONYMIZED
    assert out["table_transcripts"] == ad.NOTHING_FOUND
    assert out["storage_avatars"] == ad.DELETED
    assert out["table_users"] == ad.DELETED


def test_storage_listing_is_paginated():
    fake = FakeDB(page_size=2)
    ad.delete_account_data(USER, make_deps(fake))
    offsets = [off for bucket, _lim, off in fake.list_calls if bucket == "avatars"]
    assert max(offsets) >= 2  # more than one page was requested
    assert fake.storage["avatars"] == {f"{OTHER}/keep.png"}


@pytest.mark.parametrize(
    "op,target",
    [
        ("storage_list", "avatars"),
        ("storage_remove", "avatars"),
        ("storage_list", "themes"),
        ("storage_remove", "themes"),
        ("update", "notifications"),
        ("delete", "notifications"),
        ("delete", "ai_usage"),
        ("delete", "analytics_events"),
        ("delete", "flashcards"),
        ("delete", "notes"),
        ("delete", "study_sessions"),
        ("delete", "summaries"),
        ("delete", "profiles"),
        # The payment step reads the billing link tables (it used to read the
        # users row for the email address, which is no longer used).
        ("select", "billing_accounts"),
        ("select", "billing_subscriptions"),
        ("delete", "users"),
    ],
)
def test_partial_failure_keeps_user_row_and_retry_completes(op, target):
    fake = FakeDB()
    stripe = FakeStripe()
    fake.fail(op, target)
    first = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert not first.succeeded
    assert first.failed_steps
    assert any(r["id"] == USER for r in fake.tables["users"]), "users row must survive a failed run"

    second = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert second.succeeded, outcomes(second)
    assert not any(fake.user_rows(USER).values())
    assert stripe.calls == [("cancel", "sub_mine")]


# "list" is now Subscription.list for the linked customer. Subscription.retrieve
# is only a fallback for a linked id the listing did not return; that path is
# covered in test_billing_ownership.py.
@pytest.mark.parametrize("stage", ["list", "cancel"])
def test_stripe_failure_keeps_user_row_and_retry_cancels(stage):
    fake = FakeDB()
    stripe = FakeStripe()
    stripe.fail_next = stage
    first = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert first.failed_steps == ["cancel_subscription"]
    assert any(r["id"] == USER for r in fake.tables["users"])
    second = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert second.succeeded
    assert stripe.subscriptions["sub_mine"] == "canceled"


def test_storage_objects_left_behind_count_as_failure(monkeypatch):
    fake = FakeDB()
    original = Bucket.remove
    monkeypatch.setattr(Bucket, "remove", lambda self, paths: [])  # silently removes nothing
    report = ad.delete_account_data(USER, make_deps(fake))
    assert "storage_avatars" in report.failed_steps
    assert any(r["id"] == USER for r in fake.tables["users"])
    monkeypatch.setattr(Bucket, "remove", original)
    assert ad.delete_account_data(USER, make_deps(fake)).succeeded


def test_rerun_after_success_is_idempotent():
    fake = FakeDB()
    stripe = FakeStripe()
    assert ad.delete_account_data(USER, make_deps(fake, stripe)).succeeded
    again = ad.delete_account_data(USER, make_deps(fake, stripe))
    assert again.succeeded
    assert set(outcomes(again).values()) <= {ad.NOTHING_FOUND, ad.RETAINED}
    assert stripe.calls == [("cancel", "sub_mine")]


def test_without_stripe_configured_payment_step_is_noted_not_failed():
    fake = FakeDB()
    report = ad.delete_account_data(USER, make_deps(fake, stripe=None))
    assert report.succeeded
    step = report.steps[0]
    assert step.name == "cancel_subscription" and step.outcome == ad.RETAINED
    assert step.reason


@pytest.mark.parametrize("bad", ["", "../x", "a/b", " x", None])
def test_unsafe_user_id_is_refused_before_touching_storage(bad):
    fake = FakeDB()
    report = ad.delete_account_data(bad, make_deps(fake))
    assert not report.succeeded
    assert fake.calls == [] and fake.list_calls == []


def test_logs_have_no_ids_file_names_or_content(caplog):
    fake = FakeDB()
    fake.fail("delete", "notes")
    caplog.set_level(logging.DEBUG, logger="app.account_deletion")
    ad.delete_account_data(USER, make_deps(fake, FakeStripe()))
    ad.delete_account_data(USER, make_deps(fake, FakeStripe()))
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert text
    for forbidden in (USER, OTHER, USER_EMAIL, "Holiday", "weird name", "legacy", "secret study", "sub_mine", SYNTHETIC_HASH):
        assert forbidden not in text


# ---------- route tests ----------

@pytest.fixture
def route_env(monkeypatch):
    fake = FakeDB()
    db = DBWrapper(fake)
    stripe = FakeStripe()
    monkeypatch.setattr(main, "supabase", db)
    monkeypatch.setattr(auth_module, "get_supabase", lambda: db)
    monkeypatch.setattr(
        main,
        "build_account_deletion_deps",
        lambda: ad.DeletionDeps(db=db, stripe=stripe, stripe_secret_key="sk_test_fake",
                                clear_memory=main.clear_user_memory_state, storage_page_size=2),
    )
    main.ai_rate_limit_windows.clear()
    yield SimpleNamespace(fake=fake, stripe=stripe, client=TestClient(main.app))
    main.ai_rate_limit_windows.clear()


def auth_header(uid=USER):
    return {"Authorization": f"Bearer {create_access_token({'sub': uid})}"}


def test_route_success_response_and_token_rejected_afterwards(route_env):
    headers = auth_header()
    main.ai_rate_limit_windows[(USER, "transcribe")] = [1.0]
    main.ai_rate_limit_windows[(OTHER, "transcribe")] = [1.0]

    response = route_env.client.delete("/me/account", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["success"] is True
    assert body["message"] == "Your account and study data were deleted."
    assert any("Stripe" in item for item in body["retained"])
    assert any("AI providers" in item for item in body["retained"])
    assert "everything" not in response.text.lower()
    assert (USER, "transcribe") not in main.ai_rate_limit_windows
    assert (OTHER, "transcribe") in main.ai_rate_limit_windows

    # Same token no longer works anywhere.
    assert route_env.client.get("/notifications", headers=headers).status_code == 401
    assert route_env.client.delete("/me/account", headers=headers).status_code == 401
    # The other student's session is unaffected.
    assert route_env.client.get("/notifications", headers=auth_header(OTHER)).status_code == 200


def test_route_partial_failure_returns_500_then_retry_succeeds(route_env):
    headers = auth_header()
    route_env.fake.fail("delete", "flashcards")
    route_env.fake.fail("storage_list", "themes")
    response = route_env.client.delete("/me/account", headers=headers)
    assert response.status_code == 500
    body = response.json()
    assert body["detail"] == ad.FAILURE_DETAIL
    assert sorted(body["failed_steps"]) == ["storage_themes", "table_flashcards"]
    for leak in (USER, USER_EMAIL, "themes/", "simulated"):
        assert leak not in response.text

    # Still signed in: the same token can retry and finish.
    retry = route_env.client.delete("/me/account", headers=headers)
    assert retry.status_code == 200, retry.text
    assert not any(route_env.fake.user_rows(USER).values())
    assert route_env.fake.storage["themes"] == {f"themes/{OTHER}/keep.png"}


# ---------- legacy tables found in the live database (2026-11-15) ----------

def _with_legacy_rows(fake, sub_status):
    fake.tables["email_verification_tokens"] = [{"id": "e1", "user_id": USER}, {"id": "e2", "user_id": OTHER}]
    fake.tables["password_reset_tokens"] = [{"id": "p1", "user_id": USER}, {"id": "p2", "user_id": OTHER}]
    fake.tables["subscriptions"] = [
        {"id": "s1", "user_id": USER, "status": sub_status},
        {"id": "s2", "user_id": OTHER, "status": "active"},
    ]
    return fake


def test_legacy_token_and_inactive_subscription_rows_are_removed_before_the_users_row():
    fake = _with_legacy_rows(FakeDB(), "canceled")
    report = ad.delete_account_data(USER, make_deps(fake, FakeStripe()))
    assert report.succeeded, outcomes(report)
    for table in ("email_verification_tokens", "password_reset_tokens", "subscriptions"):
        assert not [r for r in fake.tables[table] if r["user_id"] == USER], table
        assert [r for r in fake.tables[table] if r["user_id"] == OTHER], f"{table}: other student's row must stay"
    names = [s.name for s in report.steps]
    assert names.index("table_email_verification_tokens") < names.index("table_users")
    assert names.index("table_password_reset_tokens") < names.index("table_users")


def test_billable_legacy_subscription_stops_before_any_study_data_is_deleted():
    fake = _with_legacy_rows(FakeDB(), "active")
    notes_before = [dict(r) for r in fake.tables["notes"]]
    report = ad.delete_account_data(USER, make_deps(fake, FakeStripe()))
    assert not report.succeeded
    assert report.needs_billing_review
    assert any(r["id"] == USER for r in fake.tables["users"])
    assert fake.tables["notes"] == notes_before, "nothing should be deleted while billing needs review"
    assert [r for r in fake.tables["subscriptions"] if r["user_id"] == USER], "the only billing record must be kept"


def test_missing_legacy_tables_count_as_nothing_found():
    fake = FakeDB()  # no legacy tables at all, like a fresh project
    report = ad.delete_account_data(USER, make_deps(fake, FakeStripe()))
    assert report.succeeded, outcomes(report)
    got = outcomes(report)
    assert got["table_old_subscriptions"] == ad.NOTHING_FOUND
    assert got["table_email_verification_tokens"] == ad.NOTHING_FOUND
