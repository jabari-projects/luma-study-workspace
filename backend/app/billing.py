"""Stripe billing ownership: link verified Stripe ids to Luma accounts.

Luma records which Stripe customer and subscriptions belong to which account in
public.billing_accounts and public.billing_subscriptions (see
schemas/billing_schema.sql). Ownership is never inferred from an email address:

* Checkout reuses the account's linked customer when there is one, and stamps
  the session (client_reference_id, metadata.user_id) and the subscription
  (subscription_data.metadata.luma_user_id) with the Luma user id.
* checkout.session.completed is only trusted after the session is re-read from
  Stripe and its owner fields agree. A customer already linked to another
  account is refused without changing anything.
* customer.subscription.* events are applied only to a subscription already
  linked to an account, or to one on a linked customer whose
  metadata.luma_user_id names that same account. Anything else is logged as an
  unlinked subscription event and ignored.

Legacy subscriptions created before these tables existed are NOT backfilled or
guessed: an owner links them by hand after checking the Stripe dashboard.

Logs carry event types, outcomes and at most the last four characters of a
Stripe id. Never emails, Luma user ids or full Stripe ids.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Statuses that keep Premium on. Unpaid/incomplete/paused/canceled do not.
PREMIUM_STATUSES = {"active", "trialing", "past_due"}

SUBSCRIPTION_EVENTS = {
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
}


def tail(value: Any) -> str:
    """Last four characters of an id, safe for logs."""
    if not isinstance(value, str) or not value:
        return "none"
    return "..." + value[-4:]


def _get(obj: Any, key: str) -> Any:
    """Read a field from a dict, a StripeObject (no .get in stripe 15) or an object."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    try:
        if key in obj:
            return obj[key]
        return None
    except Exception:  # noqa: BLE001 - not a mapping
        return getattr(obj, key, None)


def _id_of(value: Any) -> Optional[str]:
    if isinstance(value, str) and value:
        return value
    found = _get(value, "id")
    return found if isinstance(found, str) and found else None


def _rows(response: Any) -> list:
    data = getattr(response, "data", None) if response is not None else None
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    return []


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _period_end(subscription: Any) -> Optional[str]:
    # Newer Stripe API versions keep current_period_end on the subscription items.
    value = _get(subscription, "current_period_end")
    if not isinstance(value, (int, float)):
        items = _get(_get(subscription, "items"), "data") or []
        ends = [_get(item, "current_period_end") for item in items]
        ends = [end for end in ends if isinstance(end, (int, float))]
        value = max(ends) if ends else None
    if not isinstance(value, (int, float)):
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()


# ---------------------------------------------------------------- database


def linked_customer_id(db: Any, user_id: str) -> Optional[str]:
    rows = _rows(db.table("billing_accounts").select("*").eq("user_id", user_id).limit(1).execute())
    value = rows[0].get("stripe_customer_id") if rows else None
    return value if isinstance(value, str) and value else None


def _customer_owner(db: Any, customer_id: str) -> Optional[str]:
    rows = _rows(db.table("billing_accounts").select("*").eq("stripe_customer_id", customer_id).limit(1).execute())
    return rows[0].get("user_id") if rows else None


def _subscription_row(db: Any, subscription_id: str) -> Optional[dict]:
    rows = _rows(
        db.table("billing_subscriptions").select("*").eq("stripe_subscription_id", subscription_id).limit(1).execute()
    )
    return rows[0] if rows else None


def _user_exists(db: Any, user_id: str) -> bool:
    return bool(_rows(db.table("users").select("id").eq("id", user_id).limit(1).execute()))


def _save_subscription(db: Any, user_id: str, customer_id: str, subscription: Any) -> None:
    db.table("billing_subscriptions").upsert(
        {
            "stripe_subscription_id": _id_of(subscription),
            "user_id": user_id,
            "stripe_customer_id": customer_id,
            "status": _get(subscription, "status") or "unknown",
            "current_period_end": _period_end(subscription),
            "updated_at": _now(),
        },
        on_conflict="stripe_subscription_id",
    ).execute()


def refresh_subscription_status(db: Any, user_id: str) -> str:
    """profiles.subscription_status = premium while any linked subscription is live."""
    rows = _rows(db.table("billing_subscriptions").select("*").eq("user_id", user_id).execute())
    status = "premium" if any(row.get("status") in PREMIUM_STATUSES for row in rows) else "free"
    db.table("profiles").update({"subscription_status": status}).eq("user_id", user_id).execute()
    return status


# ---------------------------------------------------------------- checkout


LEGACY_PAID_STATUSES = {"premium", "active"}


def is_unlinked_paid_account(db: Any, user_id: str) -> bool:
    """True for a Premium profile with no billing link at all (a legacy subscription).

    Such an account must not start a new checkout: linking a second customer
    would let refresh_subscription_status and account deletion see only the new
    link, so the unlinked legacy subscription could keep billing unnoticed.
    Nothing is guessed here; the account is left for manual linking.
    """
    profiles = _rows(db.table("profiles").select("*").eq("user_id", user_id).limit(1).execute())
    status = str((profiles[0] if profiles else {}).get("subscription_status") or "").strip().lower()
    if status not in LEGACY_PAID_STATUSES:
        return False
    if _rows(db.table("billing_accounts").select("*").eq("user_id", user_id).limit(1).execute()):
        return False
    return not _rows(db.table("billing_subscriptions").select("*").eq("user_id", user_id).limit(1).execute())


def checkout_customer_params(db: Any, user_id: str, email: Optional[str]) -> dict:
    """Customer arguments for a subscription Checkout Session.

    Reuses the linked customer when there is one. Otherwise passes the email so
    Stripe can prefill it; in subscription mode Stripe always creates a customer
    (customer_creation is only accepted in payment mode).
    """
    customer_id = linked_customer_id(db, user_id)
    if customer_id:
        return {"customer": customer_id}
    return {"customer_email": email} if email else {}


# ---------------------------------------------------------------- webhook


def handle_event(event: Any, db: Any, stripe_client: Any, api_key: Optional[str]) -> str:
    """Apply one verified Stripe event. Returns a short outcome word.

    Raises on database or Stripe failures so the caller answers 500 and Stripe
    retries; every handler is safe to run twice for the same event.
    """
    event_type = _get(event, "type")
    obj = _get(_get(event, "data"), "object")
    if event_type == "checkout.session.completed":
        return _checkout_completed(obj, db, stripe_client, api_key)
    if event_type in SUBSCRIPTION_EVENTS:
        return _subscription_changed(event_type, obj, db, stripe_client, api_key)
    return "ignored"


def _refuse(reason: str, **ids: Any) -> str:
    parts = " ".join(f"{name}={tail(value)}" for name, value in ids.items())
    logger.warning("Stripe checkout refused reason=%s %s", reason, parts)
    return "refused"


def _checkout_completed(obj: Any, db: Any, stripe_client: Any, api_key: Optional[str]) -> str:
    session_id = _id_of(obj)
    claimed = _get(_get(obj, "metadata"), "user_id")
    reference = _get(obj, "client_reference_id")
    if not session_id or not isinstance(claimed, str) or not claimed or claimed != reference:
        return _refuse("owner_fields_mismatch", session=session_id)

    # Re-read from Stripe: the stored session is the source of truth.
    session = stripe_client.checkout.Session.retrieve(session_id, expand=["subscription"], api_key=api_key)
    user_id = _get(_get(session, "metadata"), "user_id")
    if user_id != claimed or _get(session, "client_reference_id") != claimed:
        return _refuse("owner_fields_mismatch", session=session_id)
    if _get(session, "mode") != "subscription" or _get(session, "status") != "complete":
        return _refuse("session_not_complete_subscription", session=session_id)
    if not _user_exists(db, user_id):
        return _refuse("unknown_user", session=session_id)

    customer_id = _id_of(_get(session, "customer"))
    subscription = _get(session, "subscription")
    if isinstance(subscription, str):
        subscription = stripe_client.Subscription.retrieve(subscription, api_key=api_key)
    subscription_id = _id_of(subscription)
    if not customer_id or not subscription_id:
        return _refuse("missing_customer_or_subscription", session=session_id)
    if _id_of(_get(subscription, "customer")) not in (None, customer_id):
        return _refuse("subscription_customer_mismatch", subscription=subscription_id, customer=customer_id)

    owner = _customer_owner(db, customer_id)
    if owner is not None and owner != user_id:
        return _refuse("customer_linked_to_another_account", customer=customer_id)
    existing = _subscription_row(db, subscription_id)
    if existing is not None and existing.get("user_id") != user_id:
        return _refuse("subscription_linked_to_another_account", subscription=subscription_id)

    current = linked_customer_id(db, user_id)
    if current is None:
        db.table("billing_accounts").upsert(
            {"user_id": user_id, "stripe_customer_id": customer_id, "updated_at": _now()},
            on_conflict="user_id",
        ).execute()
    elif current != customer_id:
        # A second customer for the same account (for example two checkouts
        # opened at once). Keep the existing link; record this subscription
        # only if Stripe's own metadata names this account.
        if _get(_get(subscription, "metadata"), "luma_user_id") != user_id:
            logger.warning(
                "Stripe checkout needs review: second customer without matching subscription metadata "
                "customer=%s subscription=%s",
                tail(customer_id),
                tail(subscription_id),
            )
            return "needs-review"
        logger.warning(
            "Stripe checkout needs review: account already linked to another customer; "
            "subscription recorded under its own customer customer=%s subscription=%s",
            tail(customer_id),
            tail(subscription_id),
        )

    _save_subscription(db, user_id, customer_id, subscription)
    status = refresh_subscription_status(db, user_id)
    logger.info("Stripe checkout linked subscription=%s status=%s", tail(subscription_id), status)
    return "linked"


def _subscription_changed(event_type: str, obj: Any, db: Any, stripe_client: Any, api_key: Optional[str]) -> str:
    subscription_id = _id_of(obj)
    customer_id = _id_of(_get(obj, "customer"))
    if not subscription_id or not customer_id:
        logger.warning("Stripe unlinked subscription event type=%s (missing ids)", event_type)
        return "unlinked"

    row = _subscription_row(db, subscription_id)
    if row is not None:
        user_id = row.get("user_id")
        if row.get("stripe_customer_id") != customer_id:
            logger.warning(
                "Stripe subscription event refused: customer differs from linked record subscription=%s",
                tail(subscription_id),
            )
            return "refused"
    else:
        owner = _customer_owner(db, customer_id)
        claimed = _get(_get(obj, "metadata"), "luma_user_id")
        if owner is None or claimed != owner:
            logger.warning(
                "Stripe unlinked subscription event type=%s subscription=%s customer=%s",
                event_type,
                tail(subscription_id),
                tail(customer_id),
            )
            return "unlinked"
        user_id = owner

    # Events can arrive late or out of order: store Stripe's current state.
    current = stripe_client.Subscription.retrieve(subscription_id, api_key=api_key)
    if _id_of(_get(current, "customer")) not in (None, customer_id):
        logger.warning("Stripe subscription event refused: customer mismatch subscription=%s", tail(subscription_id))
        return "refused"
    _save_subscription(db, user_id, customer_id, current)
    status = refresh_subscription_status(db, user_id)
    logger.info("Stripe subscription event applied type=%s subscription=%s status=%s",
                event_type, tail(subscription_id), status)
    return "updated"
