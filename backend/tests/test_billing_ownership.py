"""Stripe billing ownership: ids are linked to accounts, never guessed from email.

Fakes only: no Stripe, Supabase or network. Webhook events and retrieved
sessions are real stripe.StripeObject instances (built locally with
construct_from) so the code is exercised against stripe 15's object type,
which has no dict-style .get().
"""

from __future__ import annotations

import copy
import dataclasses
import json
import logging
from types import SimpleNamespace

import pytest
import stripe as stripe_lib
from fastapi.testclient import TestClient

from app import account_deletion as ad
from app import auth as auth_module
from app import billing, main
from app.auth import create_access_token

from tests.test_account_deletion import (
    OTHER, USER, USER_EMAIL, DBWrapper, FakeDB, delete_account, outcomes,
)

NEW = "33333333-3333-4333-8333-333333333333"
NEW_EMAIL = "new.student@example.test"
KEY = "sk_test_fake"
GOOD_SIG = "t=1,v1=valid"


# ---------------------------------------------------------------- fake Stripe


class StripeWorld:
    """In-memory Stripe: sessions, subscriptions (with customer and metadata)."""

    def __init__(self):
        self.calls: list = []
        self.fail: dict[str, int] = {}
        self.created: list[dict] = []
        self.subs: dict[str, dict] = {
            "sub_mine": {"status": "active", "customer": "cus_mine", "metadata": {"luma_user_id": USER}},
            "sub_old": {"status": "canceled", "customer": "cus_mine", "metadata": {}},
            "sub_other": {"status": "active", "customer": "cus_other", "metadata": {"luma_user_id": OTHER}},
        }
        self.sessions: dict[str, dict] = {}
        self.hide_from_list: set[str] = set()
        world = self

        class Session:
            @staticmethod
            def create(**kwargs):
                world.created.append(kwargs)
                return SimpleNamespace(url="https://checkout.example.test/session")

            @staticmethod
            def retrieve(session_id, **kwargs):
                world._call("session_retrieve", kwargs)
                data = copy.deepcopy(world.sessions[session_id])
                sub_id = data.get("subscription")
                if sub_id and "subscription" in (kwargs.get("expand") or []):
                    data["subscription"] = world._sub_dict(sub_id)
                return stripe_lib.StripeObject.construct_from(data, KEY)

        class Subscription:
            @staticmethod
            def list(**kwargs):
                world._call("list", kwargs)
                assert kwargs.get("status") == "all"
                found = [world._sub_dict(sid) for sid, sub in world.subs.items()
                         if sub["customer"] == kwargs.get("customer") and sid not in world.hide_from_list]
                return SimpleNamespace(auto_paging_iter=lambda: iter(found))

            @staticmethod
            def retrieve(sub_id, **kwargs):
                world._call("retrieve", kwargs)
                return stripe_lib.StripeObject.construct_from(world._sub_dict(sub_id), KEY)

            @staticmethod
            def cancel(sub_id, **kwargs):
                world._call("cancel", kwargs)
                world.calls.append(("cancel", sub_id))
                world.subs[sub_id]["status"] = "canceled"
                return {"id": sub_id, "status": "canceled"}

        def construct_event(payload, sig_header, secret):
            if sig_header != GOOD_SIG or secret != "whsec_fake":
                raise stripe_lib.SignatureVerificationError("bad signature", sig_header)
            return stripe_lib.Event.construct_from(json.loads(payload), KEY)

        self.checkout = SimpleNamespace(Session=Session)
        self.Subscription = Subscription
        self.Webhook = SimpleNamespace(construct_event=construct_event)
        self.SignatureVerificationError = stripe_lib.SignatureVerificationError
        self.api_key = None

    def _sub_dict(self, sub_id):
        sub = self.subs[sub_id]
        return {"id": sub_id, "object": "subscription", "status": sub["status"], "customer": sub["customer"],
                "metadata": dict(sub["metadata"]),
                "items": {"data": [{"current_period_end": 1_900_000_000}]}}

    def _call(self, name, kwargs):
        assert kwargs.get("api_key") == KEY
        left = self.fail.get(name, 0)
        if left:
            self.fail[name] = left - 1
            raise RuntimeError(f"stripe unavailable for {USER_EMAIL}")

    def add_session(self, session_id, user_id, customer, sub_id, *, reference=None, mode="subscription",
                    status="complete"):
        self.sessions[session_id] = {
            "id": session_id, "object": "checkout.session", "mode": mode, "status": status,
            "customer": customer, "subscription": sub_id,
            "client_reference_id": reference if reference is not None else user_id,
            "metadata": {"user_id": user_id},
        }


# ---------------------------------------------------------------- fixtures


def add_new_user(fake, status="free"):
    fake.tables["users"].append({"id": NEW, "email": NEW_EMAIL, "username": "new", "password": "x"})
    fake.tables["profiles"].append({"user_id": NEW, "subscription_status": status})


def profile_status(fake, uid):
    return next(r["subscription_status"] for r in fake.tables["profiles"] if r["user_id"] == uid)


def billing_snapshot(fake):
    strip = lambda rows: sorted(  # noqa: E731
        ({k: v for k, v in r.items() if k != "updated_at"} for r in rows), key=lambda r: json.dumps(r, sort_keys=True)
    )
    return {
        "accounts": strip(fake.tables["billing_accounts"]),
        "subs": strip(fake.tables["billing_subscriptions"]),
        "profiles": copy.deepcopy(fake.tables["profiles"]),
    }


@pytest.fixture
def env(monkeypatch):
    fake = FakeDB()
    db = DBWrapper(fake)
    world = StripeWorld()
    monkeypatch.setattr(main, "supabase", db)
    monkeypatch.setattr(auth_module, "get_supabase", lambda: db)
    monkeypatch.setattr(main, "stripe", world)
    monkeypatch.setattr(main, "settings", dataclasses.replace(
        main.settings, STRIPE_SECRET_KEY=KEY, STRIPE_WEBHOOK_SECRET="whsec_fake", STRIPE_PRICE_ID="price_fake"))
    monkeypatch.setattr(main, "build_account_deletion_deps", lambda: ad.DeletionDeps(
        db=db, stripe=world, stripe_secret_key=KEY, clear_memory=main.clear_user_memory_state, storage_page_size=2))
    return SimpleNamespace(fake=fake, db=db, world=world, client=TestClient(main.app))


def post_event(env, event_type, obj, event_id="evt_test_0001", sig=GOOD_SIG):
    body = {"id": event_id, "object": "event", "type": event_type, "data": {"object": obj}}
    return env.client.post("/api/stripe-webhook", content=json.dumps(body), headers={"stripe-signature": sig})


def completed(env, session_id, **kwargs):
    session = env.world.sessions[session_id]
    obj = {"id": session_id, "object": "checkout.session", "client_reference_id": session["client_reference_id"],
           "metadata": dict(session["metadata"]), **kwargs}
    return post_event(env, "checkout.session.completed", obj)


def sub_event(env, event_type, sub_id, **overrides):
    obj = {**env.world._sub_dict(sub_id), **overrides}
    return post_event(env, event_type, obj)


def deps(env):
    return ad.DeletionDeps(db=env.db, stripe=env.world, stripe_secret_key=KEY, storage_page_size=2)


def auth_header(uid):
    return {"Authorization": f"Bearer {create_access_token({'sub': uid})}"}


# ---------------------------------------------------------------- checkout


def test_checkout_reuses_linked_customer(env):
    response = env.client.post("/api/create-checkout-session", headers=auth_header(USER))
    assert response.status_code == 200, response.text
    kwargs = env.world.created[-1]
    assert kwargs["customer"] == "cus_mine"
    assert "customer_email" not in kwargs and "customer_creation" not in kwargs
    assert kwargs["client_reference_id"] == USER
    assert kwargs["metadata"] == {"user_id": USER}
    assert kwargs["subscription_data"] == {"metadata": {"luma_user_id": USER}}


def test_checkout_without_link_passes_email_only(env):
    add_new_user(env.fake)
    response = env.client.post("/api/create-checkout-session", headers=auth_header(NEW))
    assert response.status_code == 200, response.text
    kwargs = env.world.created[-1]
    assert kwargs["customer_email"] == NEW_EMAIL
    assert "customer" not in kwargs and "customer_creation" not in kwargs
    assert kwargs["subscription_data"] == {"metadata": {"luma_user_id": NEW}}


def test_checkout_refused_for_legacy_premium_without_link(env, caplog):
    # A legacy Premium account (paid on a customer Luma never linked) must not
    # link a second customer: status refresh and deletion would then see only
    # the new link and the legacy subscription could keep billing unnoticed.
    caplog.set_level(logging.DEBUG)
    add_new_user(env.fake, status="premium")
    before = billing_snapshot(env.fake)

    response = env.client.post("/api/create-checkout-session", headers=auth_header(NEW))
    assert response.status_code == 409
    assert "support" in response.json()["error"]
    assert env.world.created == []  # no Stripe session, nothing guessed
    assert billing_snapshot(env.fake) == before
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "needs manual review" in text
    for leak in (NEW, NEW_EMAIL):
        assert leak not in text

    # Deletion still stops for review rather than guessing.
    report = ad.delete_account_data(NEW, deps(env))
    assert report.needs_billing_review and env.world.calls == []

    # After the owner links the legacy customer by hand, checkout reuses it.
    env.fake.tables["billing_accounts"].append({"user_id": NEW, "stripe_customer_id": "cus_legacy"})
    response = env.client.post("/api/create-checkout-session", headers=auth_header(NEW))
    assert response.status_code == 200, response.text
    assert env.world.created[-1]["customer"] == "cus_legacy"


def test_checkout_refusal_check_fails_closed_when_link_tables_are_missing(env):
    add_new_user(env.fake, status="premium")
    del env.fake.tables["billing_accounts"]
    del env.fake.tables["billing_subscriptions"]
    response = env.client.post("/api/create-checkout-session", headers=auth_header(NEW))
    assert response.status_code == 500
    assert env.world.created == []


# ---------------------------------------------------------------- checkout.session.completed


def test_completed_webhook_links_customer_and_subscription(env):
    add_new_user(env.fake)
    env.world.subs["sub_new"] = {"status": "active", "customer": "cus_new", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_new", NEW, "cus_new", "sub_new")

    response = completed(env, "cs_new")
    assert response.status_code == 200, response.text
    assert {"user_id": NEW, "stripe_customer_id": "cus_new"}.items() <= next(
        r for r in env.fake.tables["billing_accounts"] if r["user_id"] == NEW).items()
    row = next(r for r in env.fake.tables["billing_subscriptions"] if r["stripe_subscription_id"] == "sub_new")
    assert row["user_id"] == NEW and row["stripe_customer_id"] == "cus_new" and row["status"] == "active"
    assert row["current_period_end"].startswith("2030-")
    assert profile_status(env.fake, NEW) == "premium"

    # Next checkout reuses the verified customer.
    env.client.post("/api/create-checkout-session", headers=auth_header(NEW))
    assert env.world.created[-1]["customer"] == "cus_new"


def test_completed_with_incomplete_subscription_stays_free_until_updated(env):
    add_new_user(env.fake)
    env.world.subs["sub_new"] = {"status": "incomplete", "customer": "cus_new", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_new", NEW, "cus_new", "sub_new")
    assert completed(env, "cs_new").status_code == 200
    assert profile_status(env.fake, NEW) == "free"
    env.world.subs["sub_new"]["status"] = "active"
    assert sub_event(env, "customer.subscription.updated", "sub_new").status_code == 200
    assert profile_status(env.fake, NEW) == "premium"


@pytest.mark.parametrize("case", ["body_mismatch", "stripe_mismatch", "missing_metadata", "payment_mode", "open"])
def test_forged_or_mismatched_owner_is_refused(env, case):
    add_new_user(env.fake)
    env.world.subs["sub_new"] = {"status": "active", "customer": "cus_new", "metadata": {"luma_user_id": NEW}}
    before = billing_snapshot(env.fake)
    if case == "body_mismatch":
        env.world.add_session("cs_x", NEW, "cus_new", "sub_new")
        response = completed(env, "cs_x", client_reference_id=OTHER)
        assert not [c for c in env.world.calls]  # refused before any Stripe call
    elif case == "stripe_mismatch":
        # The event body agrees with itself, but Stripe's stored session names someone else.
        env.world.subs["sub_new"]["metadata"] = {"luma_user_id": OTHER}
        env.fake.tables["billing_accounts"] = [r for r in env.fake.tables["billing_accounts"] if r["user_id"] != OTHER]
        before = billing_snapshot(env.fake)
        env.world.add_session("cs_x", OTHER, "cus_new", "sub_new", reference=OTHER)
        response = completed(env, "cs_x", client_reference_id=NEW, metadata={"user_id": NEW})
    elif case == "missing_metadata":
        env.world.add_session("cs_x", NEW, "cus_new", "sub_new")
        response = completed(env, "cs_x", metadata={})
    elif case == "payment_mode":
        env.world.add_session("cs_x", NEW, "cus_new", "sub_new", mode="payment")
        response = completed(env, "cs_x")
    else:
        env.world.add_session("cs_x", NEW, "cus_new", "sub_new", status="open")
        response = completed(env, "cs_x")
    assert response.status_code == 200  # refused, so Stripe should stop retrying
    assert billing_snapshot(env.fake) == before


def test_customer_linked_to_another_account_is_refused(env, caplog):
    add_new_user(env.fake)
    # A session for NEW whose customer is already OTHER's verified customer.
    env.world.subs["sub_new"] = {"status": "active", "customer": "cus_other", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_steal", NEW, "cus_other", "sub_new")
    before = billing_snapshot(env.fake)
    caplog.set_level(logging.DEBUG)
    response = completed(env, "cs_steal")
    assert response.status_code == 200
    assert billing_snapshot(env.fake) == before
    assert profile_status(env.fake, NEW) == "free" and profile_status(env.fake, OTHER) == "free"
    assert "customer_linked_to_another_account" in caplog.text
    assert "cus_other" not in caplog.text


def test_second_customer_for_same_account_keeps_link_and_records_subscription(env, caplog):
    env.world.subs["sub_two"] = {"status": "active", "customer": "cus_mine2", "metadata": {"luma_user_id": USER}}
    env.world.add_session("cs_two", USER, "cus_mine2", "sub_two")
    caplog.set_level(logging.WARNING)
    assert completed(env, "cs_two").status_code == 200
    assert next(r for r in env.fake.tables["billing_accounts"] if r["user_id"] == USER)["stripe_customer_id"] == "cus_mine"
    row = next(r for r in env.fake.tables["billing_subscriptions"] if r["stripe_subscription_id"] == "sub_two")
    assert row["user_id"] == USER and row["stripe_customer_id"] == "cus_mine2"
    assert "needs review" in caplog.text


def test_second_customer_without_matching_metadata_is_not_recorded(env):
    env.world.subs["sub_two"] = {"status": "active", "customer": "cus_mine2", "metadata": {}}
    env.world.add_session("cs_two", USER, "cus_mine2", "sub_two")
    before = billing_snapshot(env.fake)
    assert completed(env, "cs_two").status_code == 200
    assert billing_snapshot(env.fake) == before


def test_duplicate_completed_delivery_is_idempotent(env):
    add_new_user(env.fake)
    env.world.subs["sub_new"] = {"status": "active", "customer": "cus_new", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_new", NEW, "cus_new", "sub_new")
    assert completed(env, "cs_new").status_code == 200
    first = billing_snapshot(env.fake)
    assert completed(env, "cs_new").status_code == 200
    assert billing_snapshot(env.fake) == first
    assert len([r for r in env.fake.tables["billing_subscriptions"] if r["user_id"] == NEW]) == 1


@pytest.mark.parametrize("op,table", [
    ("upsert", "billing_accounts"), ("upsert", "billing_subscriptions"), ("update", "profiles"),
    ("select", "billing_accounts"),
])
def test_database_failure_returns_500_and_retry_completes(env, op, table):
    add_new_user(env.fake)
    env.world.subs["sub_new"] = {"status": "active", "customer": "cus_new", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_new", NEW, "cus_new", "sub_new")
    env.fake.fail(op, table)
    assert completed(env, "cs_new").status_code == 500
    assert completed(env, "cs_new").status_code == 200
    assert profile_status(env.fake, NEW) == "premium"


def test_stripe_retrieve_failure_returns_500_so_stripe_retries(env):
    add_new_user(env.fake)
    env.world.subs["sub_new"] = {"status": "active", "customer": "cus_new", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_new", NEW, "cus_new", "sub_new")
    env.world.fail["session_retrieve"] = 1
    assert completed(env, "cs_new").status_code == 500
    assert completed(env, "cs_new").status_code == 200


def test_bad_signature_and_unknown_event(env):
    before = billing_snapshot(env.fake)
    assert post_event(env, "checkout.session.completed", {"id": "cs_x"}, sig="t=1,v1=forged").status_code == 400
    assert post_event(env, "invoice.created", {"id": "in_1"}).status_code == 200
    assert billing_snapshot(env.fake) == before


# ---------------------------------------------------------------- customer.subscription.*


def test_subscription_deleted_downgrades_only_when_none_remain(env):
    env.world.subs["sub_two"] = {"status": "trialing", "customer": "cus_mine", "metadata": {"luma_user_id": USER}}
    env.fake.tables["billing_subscriptions"].append(
        {"stripe_subscription_id": "sub_two", "user_id": USER, "stripe_customer_id": "cus_mine", "status": "trialing"})

    env.world.subs["sub_mine"]["status"] = "canceled"
    assert sub_event(env, "customer.subscription.deleted", "sub_mine").status_code == 200
    assert profile_status(env.fake, USER) == "premium"  # sub_two still trialing

    env.world.subs["sub_two"]["status"] = "canceled"
    assert sub_event(env, "customer.subscription.deleted", "sub_two").status_code == 200
    assert profile_status(env.fake, USER) == "free"
    # Same event again: same result.
    assert sub_event(env, "customer.subscription.deleted", "sub_two").status_code == 200
    assert profile_status(env.fake, USER) == "free"


def test_stale_event_uses_stripe_current_state(env):
    env.world.subs["sub_mine"]["status"] = "canceled"
    # A late "updated" event still says active; Stripe's current state wins.
    assert sub_event(env, "customer.subscription.updated", "sub_mine", status="active").status_code == 200
    assert profile_status(env.fake, USER) == "free"


def test_subscription_created_on_linked_customer_with_matching_metadata_is_linked(env):
    env.world.subs["sub_new"] = {"status": "active", "customer": "cus_mine", "metadata": {"luma_user_id": USER}}
    assert sub_event(env, "customer.subscription.created", "sub_new").status_code == 200
    row = next(r for r in env.fake.tables["billing_subscriptions"] if r["stripe_subscription_id"] == "sub_new")
    assert row["user_id"] == USER


@pytest.mark.parametrize("customer,metadata", [
    ("cus_unknown", {"luma_user_id": USER}),   # customer not linked to anyone
    ("cus_mine", {"luma_user_id": OTHER}),     # linked customer, metadata names someone else
    ("cus_mine", {}),                          # linked customer, no owner in metadata
])
def test_unlinked_subscription_event_changes_nothing(env, caplog, customer, metadata):
    env.world.subs["sub_stray"] = {"status": "active", "customer": customer, "metadata": metadata}
    for row in env.fake.tables["profiles"]:
        row["subscription_status"] = "free"
    before = billing_snapshot(env.fake)
    caplog.set_level(logging.WARNING)
    for kind in ("created", "updated", "deleted"):
        assert sub_event(env, f"customer.subscription.{kind}", "sub_stray").status_code == 200
    assert billing_snapshot(env.fake) == before
    assert "unlinked subscription event" in caplog.text
    assert not [c for c in env.world.calls]


def test_event_for_linked_subscription_with_different_customer_is_refused(env):
    before = billing_snapshot(env.fake)
    assert sub_event(env, "customer.subscription.updated", "sub_mine", customer="cus_attacker").status_code == 200
    assert billing_snapshot(env.fake) == before


# ---------------------------------------------------------------- account deletion


def test_email_changed_after_paying_deletion_still_cancels_by_id(env):
    # The email change itself (code flow) is tested in test_security_gaps.py.
    next(r for r in env.fake.tables["users"] if r["id"] == USER)["email"] = "renamed.student@luma-tests.com"

    response = delete_account(env.client, auth_header(USER))
    assert response.status_code == 200, response.text
    assert env.world.calls == [("cancel", "sub_mine")]
    assert env.world.subs["sub_other"]["status"] == "active"


def test_multiple_subscriptions_all_canceled(env):
    w = env.world
    w.subs.update({
        "sub_trial": {"status": "trialing", "customer": "cus_mine", "metadata": {"luma_user_id": USER}},
        "sub_meta_only": {"status": "past_due", "customer": "cus_mine", "metadata": {"luma_user_id": USER}},
        "sub_second_cus": {"status": "unpaid", "customer": "cus_mine2", "metadata": {"luma_user_id": USER}},
        "sub_paused": {"status": "paused", "customer": "cus_mine", "metadata": {}},
        "sub_no_owner": {"status": "active", "customer": "cus_mine", "metadata": {}},
    })
    env.fake.tables["billing_subscriptions"] += [
        {"stripe_subscription_id": "sub_trial", "user_id": USER, "stripe_customer_id": "cus_mine", "status": "trialing"},
        {"stripe_subscription_id": "sub_second_cus", "user_id": USER, "stripe_customer_id": "cus_mine2", "status": "unpaid"},
        {"stripe_subscription_id": "sub_paused", "user_id": USER, "stripe_customer_id": "cus_mine", "status": "paused"},
    ]
    report = ad.delete_account_data(USER, deps(env))
    assert report.succeeded, outcomes(report)
    canceled = sorted(sub for _, sub in w.calls)
    assert canceled == ["sub_meta_only", "sub_mine", "sub_paused", "sub_second_cus", "sub_trial"]
    assert w.subs["sub_no_owner"]["status"] == "active"  # names no owner: left for review, not guessed
    assert w.subs["sub_other"]["status"] == "active"
    assert w.subs["sub_old"]["status"] == "canceled"
    assert report.steps[0].count == 5


def test_cancellation_failure_keeps_login_and_retry_completes(env):
    w = env.world
    w.subs["sub_trial"] = {"status": "trialing", "customer": "cus_mine", "metadata": {"luma_user_id": USER}}
    env.fake.tables["billing_subscriptions"].append(
        {"stripe_subscription_id": "sub_trial", "user_id": USER, "stripe_customer_id": "cus_mine", "status": "trialing"})
    real_cancel = w.Subscription.cancel
    state = {"n": 0}

    def cancel(sub_id, **kwargs):
        state["n"] += 1
        if state["n"] == 2:
            raise RuntimeError("card network timeout")
        return real_cancel(sub_id, **kwargs)

    w.Subscription = SimpleNamespace(list=w.Subscription.list, retrieve=w.Subscription.retrieve, cancel=cancel)
    first = ad.delete_account_data(USER, deps(env))
    assert first.failed_steps == ["cancel_subscription"]
    assert any(r["id"] == USER for r in env.fake.tables["users"])
    assert any(r["user_id"] == USER for r in env.fake.tables["billing_subscriptions"])
    # The login still works and retrying through the route finishes the job.
    response = delete_account(env.client, auth_header(USER))
    assert response.status_code == 200, response.text
    assert w.subs["sub_mine"]["status"] == w.subs["sub_trial"]["status"] == "canceled"
    assert sorted(sub for _, sub in w.calls) == ["sub_mine", "sub_trial"]  # each canceled once
    assert not any(r["user_id"] == USER for r in env.fake.tables["billing_subscriptions"])


def test_linked_subscription_missing_from_listing_is_retrieved_and_retried(env):
    w = env.world
    w.hide_from_list.add("sub_mine")
    w.fail["retrieve"] = 1
    first = ad.delete_account_data(USER, deps(env))
    assert first.failed_steps == ["cancel_subscription"]
    assert any(r["id"] == USER for r in env.fake.tables["users"])
    assert ad.delete_account_data(USER, deps(env)).succeeded
    assert w.calls == [("cancel", "sub_mine")]


def test_legacy_premium_without_link_needs_review_and_keeps_account(env):
    env.fake.tables["billing_accounts"] = [r for r in env.fake.tables["billing_accounts"] if r["user_id"] != USER]
    env.fake.tables["billing_subscriptions"] = [
        r for r in env.fake.tables["billing_subscriptions"] if r["user_id"] != USER]
    notes_before = [r for r in env.fake.tables["notes"] if r["user_id"] == USER]

    report = ad.delete_account_data(USER, deps(env))
    assert not report.succeeded and report.needs_billing_review
    assert report.steps[0].reason == ad.BILLING_NEEDS_REVIEW
    assert [s.name for s in report.steps] == ["cancel_subscription"]  # nothing else touched
    assert env.world.calls == []  # never guessed by email or anything else
    assert any(r["id"] == USER for r in env.fake.tables["users"])
    assert profile_status(env.fake, USER) == "premium"
    assert [r for r in env.fake.tables["notes"] if r["user_id"] == USER] == notes_before

    response = delete_account(env.client, auth_header(USER))
    assert response.status_code == 500
    assert response.json()["detail"] == (
        "We need to finish canceling your subscription by hand. Please contact support; your account is safe.")
    assert env.client.get("/notifications", headers=auth_header(USER)).status_code == 200


def test_legacy_check_also_applies_when_link_tables_are_missing(env):
    del env.fake.tables["billing_accounts"]
    del env.fake.tables["billing_subscriptions"]
    report = ad.delete_account_data(USER, deps(env))
    assert report.needs_billing_review
    assert any(r["id"] == USER for r in env.fake.tables["users"])


def test_free_account_without_link_is_nothing_found(env):
    add_new_user(env.fake, status="free")
    report = ad.delete_account_data(NEW, deps(env))
    assert report.succeeded, outcomes(report)
    assert outcomes(report)["cancel_subscription"] == ad.NOTHING_FOUND
    assert env.world.calls == []


def test_customer_record_is_never_deleted(env):
    report = ad.delete_account_data(USER, deps(env))
    assert report.succeeded
    assert report.steps[0].outcome == ad.RETAINED and "customer record" in report.steps[0].reason
    assert not hasattr(env.world, "Customer")  # no Customer API is ever touched


# ---------------------------------------------------------------- logs


def test_logs_never_contain_full_ids_or_emails(env, caplog):
    caplog.set_level(logging.DEBUG)
    add_new_user(env.fake)
    w = env.world
    w.subs["sub_new"] = {"status": "active", "customer": "cus_new", "metadata": {"luma_user_id": NEW}}
    w.add_session("cs_new", NEW, "cus_new", "sub_new")
    w.subs["sub_steal"] = {"status": "active", "customer": "cus_other", "metadata": {"luma_user_id": NEW}}
    w.add_session("cs_steal", NEW, "cus_other", "sub_steal")
    w.subs["sub_stray"] = {"status": "active", "customer": "cus_unknown", "metadata": {"luma_user_id": USER}}

    env.fake.fail("upsert", "billing_subscriptions")
    completed(env, "cs_new")
    completed(env, "cs_new")
    completed(env, "cs_steal")
    completed(env, "cs_new", client_reference_id=OTHER)
    sub_event(env, "customer.subscription.updated", "sub_stray")
    sub_event(env, "customer.subscription.deleted", "sub_new")
    w.fail["session_retrieve"] = 1
    completed(env, "cs_new")
    env.client.post("/api/create-checkout-session", headers=auth_header(NEW))
    w.fail["cancel"] = 1
    ad.delete_account_data(USER, deps(env))
    ad.delete_account_data(USER, deps(env))

    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "unlinked subscription event" in text
    for leak in ("sub_new", "sub_steal", "sub_stray", "sub_mine", "cus_new", "cus_other", "cus_unknown", "cus_mine",
                 "cs_new", "cs_steal", USER, OTHER, NEW, USER_EMAIL, NEW_EMAIL, KEY, "whsec_fake"):
        assert leak not in text, leak


def test_tail_helper_shows_only_last_four():
    assert billing.tail("sub_1234567890abcd") == "...abcd"
    assert billing.tail(None) == "none"
