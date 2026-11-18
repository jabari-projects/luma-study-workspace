"""Adversarial checks on Stripe billing ownership (independent tester).

Fakes only: no Stripe, Supabase or network calls.
"""

from __future__ import annotations

import pathlib
import re
from types import SimpleNamespace

import pytest

from app import account_deletion as ad
from app import billing

from tests.test_account_deletion import OTHER, USER, USER_EMAIL, delete_account, outcomes
from tests.test_billing_ownership import (  # noqa: F401 - env is a fixture
    KEY,
    NEW,
    NEW_EMAIL,
    add_new_user,
    auth_header,
    billing_snapshot,
    completed,
    deps,
    env,
    post_event,
    profile_status,
    sub_event,
)

APP = pathlib.Path(__file__).resolve().parents[1] / "app"


def _assert_no_leaks(text: str, ids):
    for value in ids:
        assert value not in text, f"log leaked {value[-4:]}"


# ---------------------------------------------------------------- forged / mismatched owners


def test_forged_body_naming_victim_but_stripe_session_is_attackers(env):
    """Signed event body claims USER, Stripe's stored session belongs to NEW."""
    add_new_user(env.fake)
    env.world.subs["sub_atk1"] = {"status": "active", "customer": "cus_atk1", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_atk1", NEW, "cus_atk1", "sub_atk1")
    before = billing_snapshot(env.fake)
    obj = {"id": "cs_atk1", "object": "checkout.session", "client_reference_id": USER, "metadata": {"user_id": USER}}
    r = post_event(env, "checkout.session.completed", obj)
    assert r.status_code == 200
    assert billing_snapshot(env.fake) == before


def test_attacker_session_using_victims_customer_changes_nothing(env):
    add_new_user(env.fake)
    env.world.subs["sub_atk2"] = {"status": "active", "customer": "cus_mine", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_atk2", NEW, "cus_mine", "sub_atk2")
    before = billing_snapshot(env.fake)
    assert completed(env, "cs_atk2").status_code == 200
    assert billing_snapshot(env.fake) == before
    assert profile_status(env.fake, NEW) == "free"


def test_attacker_session_claiming_victims_existing_subscription_is_refused(env):
    add_new_user(env.fake)
    # Stripe session for NEW whose subscription id is USER's linked one, on a fresh customer.
    env.world.subs["sub_mine"]["customer"] = "cus_new9"
    env.world.add_session("cs_atk3", NEW, "cus_new9", "sub_mine")
    before = billing_snapshot(env.fake)
    assert completed(env, "cs_atk3").status_code == 200
    assert billing_snapshot(env.fake) == before


def test_subscription_metadata_pointing_at_victim_on_attacker_customer_is_unlinked(env):
    # OTHER owns cus_other. A subscription there claims USER: must not touch USER.
    env.fake.tables["profiles"][0]["subscription_status"] = "free"
    env.world.subs["sub_evil"] = {"status": "active", "customer": "cus_other", "metadata": {"luma_user_id": USER}}
    before = billing_snapshot(env.fake)
    r = sub_event(env, "customer.subscription.created", "sub_evil")
    assert r.status_code == 200
    assert billing_snapshot(env.fake) == before
    assert profile_status(env.fake, USER) == "free"


def test_subscription_metadata_pointing_at_victim_on_unlinked_customer_is_unlinked(env):
    env.fake.tables["profiles"][0]["subscription_status"] = "free"
    env.world.subs["sub_evil2"] = {"status": "active", "customer": "cus_nobody", "metadata": {"luma_user_id": USER}}
    before = billing_snapshot(env.fake)
    assert sub_event(env, "customer.subscription.updated", "sub_evil2").status_code == 200
    assert billing_snapshot(env.fake) == before


def test_linked_subscription_moved_to_attacker_customer_in_body_is_refused(env):
    before = billing_snapshot(env.fake)
    r = sub_event(env, "customer.subscription.deleted", "sub_mine", customer="cus_other", status="canceled")
    assert r.status_code == 200
    assert billing_snapshot(env.fake) == before


# ---------------------------------------------------------------- ordering


def test_updated_before_completed_then_completed_links_with_current_state(env):
    add_new_user(env.fake)
    env.world.subs["sub_n1"] = {"status": "active", "customer": "cus_n1", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_n1", NEW, "cus_n1", "sub_n1")
    # updated arrives first: nothing linked yet, so ignored.
    assert sub_event(env, "customer.subscription.updated", "sub_n1").status_code == 200
    assert not [r for r in env.fake.tables["billing_subscriptions"] if r["user_id"] == NEW]
    assert profile_status(env.fake, NEW) == "free"
    assert completed(env, "cs_n1").status_code == 200
    assert profile_status(env.fake, NEW) == "premium"
    # A late, stale "created" event with an old status: Stripe's current state wins.
    env.world.subs["sub_n1"]["status"] = "canceled"
    assert sub_event(env, "customer.subscription.created", "sub_n1", status="active").status_code == 200
    assert profile_status(env.fake, NEW) == "free"
    # Completed replayed after cancel: stays free (no resurrection).
    assert completed(env, "cs_n1").status_code == 200
    assert profile_status(env.fake, NEW) == "free"


def test_deleted_event_for_one_of_two_subscriptions_keeps_premium(env):
    env.world.subs["sub_two"] = {"status": "active", "customer": "cus_mine", "metadata": {"luma_user_id": USER}}
    assert sub_event(env, "customer.subscription.created", "sub_two").status_code == 200
    env.world.subs["sub_two"]["status"] = "canceled"
    assert sub_event(env, "customer.subscription.deleted", "sub_two").status_code == 200
    assert profile_status(env.fake, USER) == "premium"
    env.world.subs["sub_mine"]["status"] = "canceled"
    assert sub_event(env, "customer.subscription.deleted", "sub_mine").status_code == 200
    assert profile_status(env.fake, USER) == "free"
    # OTHER untouched throughout.
    assert profile_status(env.fake, OTHER) == "free"


# ---------------------------------------------------------------- partial DB failure + retry


@pytest.mark.parametrize("op,table", [
    ("upsert", "billing_accounts"),
    ("upsert", "billing_subscriptions"),
    ("update", "profiles"),
    ("select", "billing_subscriptions"),
])
def test_partial_failure_then_retry_converges(env, op, table):
    add_new_user(env.fake)
    env.world.subs["sub_n2"] = {"status": "active", "customer": "cus_n2", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_n2", NEW, "cus_n2", "sub_n2")
    env.fake.fail(op, table)
    assert completed(env, "cs_n2").status_code == 500
    assert completed(env, "cs_n2").status_code == 200
    first = billing_snapshot(env.fake)
    assert completed(env, "cs_n2").status_code == 200
    assert billing_snapshot(env.fake) == first
    assert [r["stripe_customer_id"] for r in env.fake.tables["billing_accounts"] if r["user_id"] == NEW] == ["cus_n2"]
    assert profile_status(env.fake, NEW) == "premium"


def test_subscription_event_db_failure_then_retry(env):
    env.world.subs["sub_mine"]["status"] = "canceled"
    env.fake.fail("update", "profiles")
    assert sub_event(env, "customer.subscription.deleted", "sub_mine").status_code == 500
    assert sub_event(env, "customer.subscription.deleted", "sub_mine").status_code == 200
    assert profile_status(env.fake, USER) == "free"


# ---------------------------------------------------------------- deletion: pagination and mid-cancel errors


class PagedSubscriptions:
    """Subscription API whose list pages lazily, 100 per page, like Stripe."""

    def __init__(self, subs, fail_page=None, fail_cancel_at=None):
        self.subs = subs
        self.fail_page = fail_page
        self.fail_cancel_at = fail_cancel_at
        self.cancels: list[str] = []
        self.cancel_attempts = 0
        self.pages_fetched = 0

    def list(self, **kwargs):
        assert kwargs.get("status") == "all" and kwargs.get("api_key") == KEY
        assert "email" not in kwargs
        found = [dict(id=i, **s) for i, s in self.subs.items() if s["customer"] == kwargs["customer"]]
        limit = kwargs.get("limit", 10)
        first = found[:limit]
        api = self

        def pager():
            page, start = first, 0
            while True:
                yield from page
                start += limit
                if start >= len(found):
                    return
                api.pages_fetched += 1
                if api.fail_page is not None and api.pages_fetched == api.fail_page:
                    raise RuntimeError("page fetch failed")
                page = found[start:start + limit]

        # data holds only the first page; has_more says there is more.
        return SimpleNamespace(data=first, has_more=len(found) > limit, auto_paging_iter=pager)

    def retrieve(self, sub_id, **kwargs):
        return dict(id=sub_id, **self.subs[sub_id])

    def cancel(self, sub_id, **kwargs):
        self.cancel_attempts += 1
        if self.fail_cancel_at is not None and self.cancel_attempts == self.fail_cancel_at:
            raise RuntimeError("card_declined-ish stripe error")
        self.subs[sub_id]["status"] = "canceled"
        self.cancels.append(sub_id)
        return {"id": sub_id, "status": "canceled"}


def _many_subs(n):
    subs = {f"sub_bulk_{i:04d}": {"status": "active", "customer": "cus_mine", "metadata": {"luma_user_id": USER}}
            for i in range(n)}
    subs["sub_mine"] = {"status": "active", "customer": "cus_mine", "metadata": {"luma_user_id": USER}}
    subs["sub_old"] = {"status": "canceled", "customer": "cus_mine", "metadata": {}}
    subs["sub_other"] = {"status": "active", "customer": "cus_other", "metadata": {"luma_user_id": OTHER}}
    return subs


def _deps_with(env, api):
    return ad.DeletionDeps(db=env.db, stripe=SimpleNamespace(Subscription=api), stripe_secret_key=KEY,
                           storage_page_size=2)


def test_deletion_cancels_more_than_100_subscriptions_across_pages(env):
    api = PagedSubscriptions(_many_subs(250))
    report = ad.delete_account_data(USER, _deps_with(env, api))
    assert not report.failed_steps
    owned = {i for i, s in api.subs.items() if s["metadata"].get("luma_user_id") == USER}
    assert set(api.cancels) == owned and len(api.cancels) == 251
    assert len(api.cancels) == len(set(api.cancels))
    assert api.subs["sub_other"]["status"] == "active"


def test_page_fetch_failure_fails_step_and_keeps_login(env):
    api = PagedSubscriptions(_many_subs(250), fail_page=2)
    report = ad.delete_account_data(USER, _deps_with(env, api))
    assert report.failed_steps == ["cancel_subscription"]
    assert any(r["id"] == USER for r in env.fake.tables["users"])
    api.fail_page = None
    report = ad.delete_account_data(USER, _deps_with(env, api))
    assert not report.failed_steps
    assert all(s["status"] == "canceled" for s in api.subs.values() if s["metadata"].get("luma_user_id") == USER)


def test_stripe_error_mid_cancel_keeps_login_and_retry_finishes_without_double_cancel(env):
    api = PagedSubscriptions(_many_subs(5), fail_cancel_at=3)
    report = ad.delete_account_data(USER, _deps_with(env, api))
    assert report.failed_steps == ["cancel_subscription"]
    assert len(api.cancels) == 2
    assert any(r["id"] == USER for r in env.fake.tables["users"])
    assert env.fake.tables["billing_subscriptions"], "links must survive so retry can find them"
    report = ad.delete_account_data(USER, _deps_with(env, api))
    assert not report.failed_steps
    assert len(api.cancels) == 6 and len(set(api.cancels)) == 6
    assert not any(r["id"] == USER for r in env.fake.tables["users"])
    assert api.subs["sub_other"]["status"] == "active"


# ---------------------------------------------------------------- legacy: never guess


def test_legacy_premium_never_calls_stripe_or_guesses_by_email(env):
    add_new_user(env.fake, status="premium")
    calls = []

    class Spy:
        def __getattr__(self, name):
            calls.append(name)
            raise AssertionError("Stripe must not be called for an unlinked legacy account")

    d = ad.DeletionDeps(db=env.db, stripe=SimpleNamespace(Subscription=Spy(), Customer=Spy(),
                                                          checkout=SimpleNamespace(Session=Spy())),
                        stripe_secret_key=KEY, storage_page_size=2)
    report = ad.delete_account_data(NEW, d)
    assert report.failed_steps == ["cancel_subscription"]
    assert report.needs_billing_review
    assert calls == []
    assert any(r["id"] == NEW for r in env.fake.tables["users"])
    assert profile_status(env.fake, NEW) == "premium"
    # Retry still refuses (status preserved, not quietly deleted).
    report = ad.delete_account_data(NEW, d)
    assert report.needs_billing_review and any(r["id"] == NEW for r in env.fake.tables["users"])


def test_legacy_route_message(env):
    add_new_user(env.fake, status="active")
    r = delete_account(env.client, auth_header(NEW), "x")
    assert r.status_code == 500
    assert r.json()["detail"] == ad.BILLING_REVIEW_DETAIL
    assert any(row["id"] == NEW for row in env.fake.tables["users"])
    assert env.world.calls == []


# ---------------------------------------------------------------- email lookup is gone


def test_no_email_based_stripe_lookup_in_billing_or_deletion():
    for name in ("account_deletion.py", "billing.py"):
        src = (APP / name).read_text(encoding="utf-8")
        code = "\n".join(line for line in src.splitlines() if not line.strip().startswith("#"))
        code = re.sub(r'"""[\s\S]*?"""', "", code)
        assert "Session.list" not in code, name
        assert "Customer.list" not in code and "Customer.search" not in code, name
        assert not re.search(r"customer_email\s*=", code), name
        assert "customer_details" not in code, name
    deletion = (APP / "account_deletion.py").read_text(encoding="utf-8")
    body = deletion.split("def step_cancel_stripe", 1)[1].split("\ndef ", 1)[0]
    body = re.sub(r'"""[\s\S]*?"""', "", body)
    assert "email" not in body.lower()


# ---------------------------------------------------------------- checkout


def test_checkout_with_linked_customer_never_sends_email(env):
    for uid in (USER, OTHER):
        r = env.client.post("/api/create-checkout-session", headers=auth_header(uid))
        assert r.status_code == 200
        kwargs = env.world.created[-1]
        assert "customer_email" not in kwargs
        assert kwargs["customer"] == ("cus_mine" if uid == USER else "cus_other")
    assert billing.checkout_customer_params(env.db, USER, USER_EMAIL) == {"customer": "cus_mine"}
    assert billing.checkout_customer_params(env.db, NEW, None) == {}


# ---------------------------------------------------------------- logs


def test_adversarial_flows_never_log_full_ids_or_emails(env, caplog):
    caplog.set_level("DEBUG")
    add_new_user(env.fake)
    env.world.subs["sub_atk_9z9z"] = {"status": "active", "customer": "cus_mine", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_atk_9z9z", NEW, "cus_mine", "sub_atk_9z9z")
    completed(env, "cs_atk_9z9z")
    env.world.subs["sub_evil_7y7y"] = {"status": "active", "customer": "cus_other", "metadata": {"luma_user_id": USER}}
    sub_event(env, "customer.subscription.created", "sub_evil_7y7y")
    env.fake.fail("upsert", "billing_subscriptions")
    env.world.subs["sub_n3x3x"] = {"status": "active", "customer": "cus_n3x3x", "metadata": {"luma_user_id": NEW}}
    env.world.add_session("cs_n3x3x", NEW, "cus_n3x3x", "sub_n3x3x")
    completed(env, "cs_n3x3x")
    api = PagedSubscriptions(_many_subs(3), fail_cancel_at=2)
    ad.delete_account_data(USER, _deps_with(env, api))
    add_new_user  # noqa: B018
    text = "\n".join(r.getMessage() for r in caplog.records)
    _assert_no_leaks(text, [
        USER, OTHER, NEW, USER_EMAIL, NEW_EMAIL, "cus_mine", "cus_other", "sub_atk_9z9z", "cs_atk_9z9z",
        "sub_evil_7y7y", "cus_n3x3x", "sub_n3x3x", "cs_n3x3x", "sub_mine", "sub_other", KEY, "whsec_fake",
    ])
