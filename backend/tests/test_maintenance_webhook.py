"""Stripe webhooks during maintenance (fake Stripe, fake database).

During a break (active or checking) the gate answers 503 with Retry-After: 600, so Stripe
keeps the event and retries it later. In every other phase, draining included, the event
is handled as usual, and the handler runs in the thread pool (not on the event loop).
"""

import dataclasses
import threading
from types import SimpleNamespace

import pytest

from app import billing, main
from tests.maintenance_fakes import world  # noqa: F401


class _SigError(Exception):
    pass


@pytest.fixture
def stripe_env(world, monkeypatch):
    handled = []

    def construct_event(payload, sig_header, secret):
        assert sig_header == "t=1,v1=fake" and secret == "whsec_fake"
        return {"id": "evt_synthetic_1", "type": "customer.subscription.updated", "data": {"object": {}}}

    def handle_event(event, db, stripe_module, key):
        handled.append({"event": event["id"], "thread": threading.current_thread().name})
        return "ignored"

    fake_stripe = SimpleNamespace(
        api_key=None,
        Webhook=SimpleNamespace(construct_event=construct_event),
        SignatureVerificationError=_SigError,
    )
    monkeypatch.setattr(main, "stripe", fake_stripe)
    monkeypatch.setattr(
        main, "settings", dataclasses.replace(main.settings, STRIPE_SECRET_KEY="sk_test_fake", STRIPE_WEBHOOK_SECRET="whsec_fake")
    )
    monkeypatch.setattr(billing, "handle_event", handle_event)
    pool_calls = []
    real_pool = main.run_in_threadpool

    async def spy(fn, *args, **kwargs):
        pool_calls.append(fn)
        return await real_pool(fn, *args, **kwargs)

    monkeypatch.setattr(main, "run_in_threadpool", spy)
    world.handled = handled
    world.pool_calls = pool_calls
    return world


def deliver(w):
    return w.signed_out().post(
        "/api/stripe-webhook", content=b'{"id":"evt_synthetic_1"}', headers={"stripe-signature": "t=1,v1=fake"}
    )


@pytest.mark.parametrize("step", ["none", "announced", "draining"])
def test_webhooks_are_handled_outside_the_break(stripe_env, step):
    w = stripe_env
    if step != "none":
        w.schedule()
    if step == "draining":
        w.drain()
    response = deliver(w)
    assert response.status_code == 200 and response.json() == {"success": True}
    assert [h["event"] for h in w.handled] == ["evt_synthetic_1"]
    # billing.handle_event ran through run_in_threadpool, on a worker thread.
    assert w.pool_calls == [billing.handle_event]
    assert w.handled[0]["thread"] != threading.main_thread().name


@pytest.mark.parametrize("phase", ["draining_after_grace", "active", "checking"])
def test_webhooks_wait_during_the_break(stripe_env, phase):
    w = stripe_env
    if phase == "draining_after_grace":
        # From the last settle seconds of the grace on, events wait too.
        w.schedule()
        w.drain()
        w.clock.advance(minutes=30)
    elif phase == "active":
        w.to_active()
    else:
        w.to_checking()
    response = deliver(w)
    assert response.status_code == 503
    assert response.headers["retry-after"] == "600"
    assert response.json()["retry_after"] == 600
    assert w.handled == []  # nothing was half-done; Stripe sends it again later
    # After reopening, the retried delivery goes through once.
    if phase == "draining_after_grace":
        assert w.activate().status_code == 200
    if phase in ("draining_after_grace", "active"):
        assert w.checks().status_code == 200
    assert w.reopen().status_code == 200
    assert deliver(w).status_code == 200
    assert [h["event"] for h in w.handled] == ["evt_synthetic_1"]
