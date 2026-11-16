"""Account deletion for Luma: what we hold about a student and how it is removed.

INVENTORY (from app code, app/schemas/*.sql and the routes, Nov 2026)

Database (Supabase Postgres, service-role client):
  users              id = user id. email, username, password hash, role,
                     email_verified, email_verification_token(+sent_at),
                     password_reset_token(+sent_at) (tokens stored as SHA-256).
                     -> deleted LAST, only when every earlier step succeeded.
  profiles           user_id. username, display_name, avatar_url,
                     custom_theme_image_url, theme_color/mode, timezone,
                     phone_number, birthday, subscription_status, role.
                     -> deleted (after its child tables; they reference it).
  notes              user_id (FK profiles.user_id, no cascade) -> deleted.
  flashcards         user_id (FK profiles.user_id, no cascade) -> deleted.
  summaries          user_id (FK profiles.user_id, no cascade) -> deleted.
  study_sessions     user_id (FK profiles.user_id, no cascade) -> deleted.
  transcripts        user_id (FK profiles.user_id, no cascade) -> deleted.
                     Published (public) notes/flashcards/summaries are the same
                     rows (is_public, published_by), so they go too.
  ai_usage           user_id (FK profiles) -> deleted.
  analytics_events   user_id (FK profiles, on delete set null), page_path,
                     metadata -> deleted (not just nulled).
  notifications      user_id (FK users, cascade) -> deleted.
                     actor_user_id on OTHER students' notifications
                     -> anonymized (set to null).
  billing_accounts / billing_subscriptions  user_id (FK users, cascade):
                     Stripe customer/subscription ids and status
                     -> removed with the users row (see Payment provider).
  No separate roles / email / reset tables exist: those are columns on
  users/profiles and disappear with those rows.

Supabase Storage:
  avatars bucket     "<user_id>/<random>.<ext>" (older uploads may have any
                     name) -> every object under the prefix is listed in pages
                     and removed, then the prefix is re-listed to confirm.
  themes bucket      "themes/<user_id>/<random>.<ext>" -> same.

Payment provider (Stripe):
  billing_accounts (user_id -> stripe_customer_id) and billing_subscriptions
  (stripe_subscription_id -> user_id, customer, status) link verified Stripe
  ids to the account; see app/billing.py. Deletion cancels, by id, every
  live subscription in billing_subscriptions plus any subscription on a linked
  customer whose metadata.luma_user_id is this user. The email address is never
  used to find subscriptions. A Premium account with no billing link (legacy,
  from before the link tables) is NOT guessed at: the step fails as
  billing_needs_review, nothing else is removed and the account stays until
  support links or cancels it by hand. Any Stripe error fails the step so a
  retry continues. The billing rows go with the users row (on delete cascade).
  The Stripe customer, invoices, charges and receipts are NOT deleted: they are
  financial/tax records held by Stripe (retained-with-reason); deleting the
  customer record is an owner decision.

In-memory (per process): AI rate-limit windows keyed by user id and open
  websocket registrations -> cleared after the users row is gone. Login and
  reset-email limiters are keyed by IP/email, not user id, and simply expire.

Logs: designed to hold no study content; this module logs only step names and
  outcomes (no ids, no file names, no content). Hosting-provider log retention
  is outside this code.

Third parties: content already sent to OpenAI (notes/summaries/images) and
  Deepgram (audio) follows their own retention rules; Luma cannot delete it from
  code. Email already delivered through Resend stays in the recipient's inbox
  and Resend's logs. Supabase database backups age out on Supabase's schedule.

Sessions: the custom JWT carries a credential fingerprint ("pv"); once the users
  row is gone the fingerprint lookup returns nothing and the token is rejected.
  Tokens without a "pv" claim (issued before the fingerprint existed) are
  still checked against the users row and rejected once it is gone.

Safety: deletion refuses to run unless the database client uses the
  service-role key (DeletionDeps.privileged_db), and every table delete is
  re-checked with a select so a delete that silently affected nothing (RLS)
  fails the step instead of letting the users row go.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

logger = logging.getLogger(__name__)

DELETED = "deleted"
ANONYMIZED = "anonymized"
NOTHING_FOUND = "nothing-found"
FAILED = "failed"
RETAINED = "retained-with-reason"

OK_OUTCOMES = {DELETED, ANONYMIZED, NOTHING_FOUND, RETAINED}

# Child tables first: they reference profiles(user_id) without cascade.
CHILD_TABLES = (
    "notifications",
    "ai_usage",
    "analytics_events",
    "flashcards",
    "notes",
    "study_sessions",
    "summaries",
    "transcripts",
)

# Older tables that exist in the live database but that today's code no longer uses.
# They reference users(id) without cascade, so their rows must go before the users row,
# or the final delete fails (found on a replica of the live database, 2026-11-15).
LEGACY_TOKEN_TABLES = ("email_verification_tokens", "password_reset_tokens")

STORAGE_PREFIXES = (
    ("avatars", "{user_id}"),
    ("themes", "themes/{user_id}"),
)

ACTIVE_SUBSCRIPTION_STATUSES = {"active", "trialing", "past_due", "unpaid", "incomplete", "paused"}

FAILURE_DETAIL = (
    "We couldn't finish deleting your account. Some of your data may already be "
    "removed, and your account is still active so you can try again. If it keeps "
    "happening, contact support."
)
SUCCESS_MESSAGE = "Your account and study data were deleted."

RETAINED_PAYMENTS = "If you paid for Premium, payment records stay with Stripe because tax law requires them"
RETAINED_AI = "Copies already sent to our AI providers follow their own deletion rules"
RETAINED_BACKUPS = "Database backups age out on our hosting provider's schedule"


@dataclass
class StepResult:
    name: str
    outcome: str
    count: int = 0
    reason: Optional[str] = None


@dataclass
class DeletionDeps:
    db: Any
    stripe: Any = None
    stripe_secret_key: Optional[str] = None
    clear_memory: Optional[Callable[[str], None]] = None
    storage_page_size: int = 100
    max_storage_depth: int = 4
    max_storage_pages: int = 1000
    # False when the client is not using the service-role key (for example the
    # anon SUPABASE_KEY fallback). Under row-level security such a client can
    # "delete" zero rows without an error, so deletion refuses to run.
    privileged_db: bool = True


@dataclass
class DeletionReport:
    steps: list[StepResult] = field(default_factory=list)

    @property
    def succeeded(self) -> bool:
        return bool(self.steps) and all(step.outcome in OK_OUTCOMES for step in self.steps)

    @property
    def failed_steps(self) -> list[str]:
        return [step.name for step in self.steps if step.outcome == FAILED]

    @property
    def needs_billing_review(self) -> bool:
        return any(step.outcome == FAILED and step.reason == BILLING_NEEDS_REVIEW for step in self.steps)

    @property
    def retained(self) -> list[str]:
        return [RETAINED_PAYMENTS, RETAINED_AI, RETAINED_BACKUPS]


class _StepFailed(Exception):
    pass


def _data(response: Any) -> Any:
    return getattr(response, "data", None) if response is not None else None


def _rows(response: Any) -> list:
    data = _data(response)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    return []


MISSING_TABLE_CODES = {"PGRST205", "42P01"}


def _is_missing_table(exc: Exception) -> bool:
    """True only for "this table does not exist" errors.

    Matches the PostgREST/Postgres error codes (or the exact PostgREST text),
    never a generic "does not exist": a missing column (42703) or any other
    error must fail the step instead of looking like "nothing to delete".
    """
    if getattr(exc, "code", None) in MISSING_TABLE_CODES:
        return True
    text = str(exc)
    if "Could not find the table" in text:
        return True
    return any(re.search(rf"(?<![A-Za-z0-9]){code}(?![A-Za-z0-9])", text) for code in MISSING_TABLE_CODES)


def _safe_user_id(user_id: Any) -> str:
    if not isinstance(user_id, str):
        raise ValueError("user id must be a string")
    cleaned = user_id.strip()
    if not cleaned or cleaned != user_id or "/" in cleaned or "\\" in cleaned or ".." in cleaned:
        raise ValueError("unsafe user id")
    return cleaned


# ---------- individual steps (each safe to re-run) ----------

def _load_user(db: Any, user_id: str) -> Optional[dict]:
    rows = _rows(db.table("users").select("*").eq("id", user_id).limit(1).execute())
    return rows[0] if rows else None


def _load_profile(db: Any, user_id: str) -> Optional[dict]:
    try:
        rows = _rows(db.table("profiles").select("*").eq("user_id", user_id).limit(1).execute())
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return None
        raise
    return rows[0] if rows else None


def _get(obj: Any, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    getter = getattr(obj, "get", None)
    if callable(getter):
        try:
            return getter(key)
        except Exception:  # noqa: BLE001
            pass
    return getattr(obj, key, None)


def _iterate(listing: Any) -> Iterable:
    pager = getattr(listing, "auto_paging_iter", None)
    if callable(pager):
        return pager()
    data = _get(listing, "data")
    return data or []


BILLING_NEEDS_REVIEW = "billing_needs_review"
BILLING_REVIEW_DETAIL = (
    "We need to finish canceling your subscription by hand. Please contact support; your account is safe."
)
LEGACY_PAID_STATUSES = {"premium", "active"}


def _billing_rows(db: Any, table: str, user_id: str) -> list:
    try:
        return _rows(db.table(table).select("*").eq("user_id", user_id).execute())
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            # billing_schema.sql not applied yet: no links exist.
            return []
        raise


def step_cancel_stripe(user_id: str, deps: DeletionDeps) -> StepResult:
    """Cancel every Stripe subscription linked to this account, by id only.

    Ownership comes from billing_accounts / billing_subscriptions, never from
    the email address. A Premium account with no billing link (a legacy
    subscription from before the link tables) is not guessed at: the step
    fails as billing_needs_review so the account stays until someone links or
    cancels it by hand. The Stripe customer and invoices are kept.
    """
    name = "cancel_subscription"
    if deps.stripe is None or not deps.stripe_secret_key:
        return StepResult(name, RETAINED, reason="payments not configured; nothing to cancel from Luma")

    db = deps.db
    key = deps.stripe_secret_key
    accounts = _billing_rows(db, "billing_accounts", user_id)
    linked_rows = _billing_rows(db, "billing_subscriptions", user_id)

    linked_ids = {row.get("stripe_subscription_id") for row in linked_rows}
    linked_ids = {sub_id for sub_id in linked_ids if isinstance(sub_id, str) and sub_id}
    customer_ids = {row.get("stripe_customer_id") for row in [*accounts, *linked_rows]}
    customer_ids = {cid for cid in customer_ids if isinstance(cid, str) and cid}

    if not linked_ids and not customer_ids:
        profile = _load_profile(db, user_id) or {}
        if str(profile.get("subscription_status") or "").lower() in LEGACY_PAID_STATUSES:
            logger.warning("Account deletion: paid account has no billing link; needs manual review")
            return StepResult(name, FAILED, reason=BILLING_NEEDS_REVIEW)
        return StepResult(name, NOTHING_FOUND)

    statuses: dict[str, Any] = {}
    skipped = 0
    for customer_id in sorted(customer_ids):
        listing = deps.stripe.Subscription.list(customer=customer_id, status="all", limit=100, api_key=key)
        for subscription in _iterate(listing):
            sub_id = _get(subscription, "id")
            if not isinstance(sub_id, str) or not sub_id:
                continue
            metadata = _get(subscription, "metadata") or {}
            if sub_id in linked_ids or _get(metadata, "luma_user_id") == user_id:
                statuses[sub_id] = _get(subscription, "status")
            else:
                skipped += 1
    for sub_id in sorted(linked_ids - set(statuses)):
        statuses[sub_id] = _get(deps.stripe.Subscription.retrieve(sub_id, api_key=key), "status")
    if skipped:
        logger.warning("Account deletion: %s subscription(s) on a linked customer name no owner; left for review", skipped)

    canceled = 0
    for sub_id in sorted(statuses):
        if statuses[sub_id] in ACTIVE_SUBSCRIPTION_STATUSES:
            deps.stripe.Subscription.cancel(sub_id, api_key=key)
            canceled += 1

    reason = "invoices, charges and the Stripe customer record are kept by Stripe as tax records"
    if canceled:
        return StepResult(name, RETAINED, count=canceled, reason="subscription canceled; " + reason)
    return StepResult(name, RETAINED, reason=reason)


def _list_storage_paths(bucket_api: Any, folder: str, deps: DeletionDeps, depth: int = 0) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    offset = 0
    pages = 0
    page_size = max(1, int(deps.storage_page_size))
    max_pages = max(1, int(deps.max_storage_pages))
    while True:
        pages += 1
        if pages > max_pages:
            raise _StepFailed("storage listing exceeded the page limit")
        entries = bucket_api.list(folder, {"limit": page_size, "offset": offset, "sortBy": {"column": "name", "order": "asc"}})
        entries = entries or []
        new_names = 0
        for entry in entries:
            entry_name = _get(entry, "name")
            if not isinstance(entry_name, str) or not entry_name or entry_name in (".", ".."):
                continue
            if entry_name in seen:
                continue
            seen.add(entry_name)
            new_names += 1
            full_path = f"{folder}/{entry_name}"
            is_folder = _get(entry, "id") is None and _get(entry, "metadata") is None
            if is_folder:
                if depth + 1 > deps.max_storage_depth:
                    raise _StepFailed("storage folder nesting too deep")
                paths.extend(_list_storage_paths(bucket_api, full_path, deps, depth + 1))
            else:
                paths.append(full_path)
        if len(entries) < page_size:
            return paths
        if new_names == 0:
            # A full page with nothing new: the server is ignoring the offset.
            raise _StepFailed("storage listing made no progress")
        offset += page_size


def step_remove_storage(user_id: str, deps: DeletionDeps, bucket: str, prefix_template: str) -> StepResult:
    name = f"storage_{bucket}"
    prefix = prefix_template.format(user_id=user_id)
    bucket_api = deps.db.storage.from_(bucket)
    paths = _list_storage_paths(bucket_api, prefix, deps)
    if not paths:
        return StepResult(name, NOTHING_FOUND)
    chunk = max(1, int(deps.storage_page_size))
    for start in range(0, len(paths), chunk):
        bucket_api.remove(paths[start:start + chunk])
    leftover = _list_storage_paths(bucket_api, prefix, deps)
    if leftover:
        raise _StepFailed("storage objects remain after removal")
    return StepResult(name, DELETED, count=len(paths))


def step_anonymize_actor(user_id: str, deps: DeletionDeps) -> StepResult:
    name = "notifications_actor"
    try:
        response = (
            deps.db.table("notifications")
            .update({"actor_user_id": None})
            .eq("actor_user_id", user_id)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return StepResult(name, NOTHING_FOUND)
        raise
    count = len(_rows(response))
    return StepResult(name, ANONYMIZED if count else NOTHING_FOUND, count=count)


def step_delete_rows(user_id: str, deps: DeletionDeps, table: str, column: str = "user_id") -> StepResult:
    name = f"table_{table}"
    try:
        response = deps.db.table(table).delete().eq(column, user_id).execute()
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return StepResult(name, NOTHING_FOUND, reason="table not present")
        raise
    count = len(_rows(response))
    # Do not trust the delete's returned rows alone: under RLS, or with
    # returning=minimal, a delete can affect nothing without raising.
    remaining = _rows(deps.db.table(table).select(column).eq(column, user_id).limit(1).execute())
    if remaining:
        raise _StepFailed("rows remain after delete")
    return StepResult(name, DELETED if count else NOTHING_FOUND, count=count)


def step_delete_legacy_subscriptions(user_id: str, deps: DeletionDeps) -> StepResult:
    """Remove this user's rows from the old public.subscriptions table.

    Never deletes a row that still looks billable: that's the only record of an
    unlinked old Stripe subscription, so it stops for a manual billing review instead.
    """
    name = "table_old_subscriptions"
    try:
        rows = _rows(deps.db.table("subscriptions").select("status").eq("user_id", user_id).execute())
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return StepResult(name, NOTHING_FOUND, reason="table not present")
        raise
    if any(str(row.get("status") or "").lower() in ACTIVE_SUBSCRIPTION_STATUSES for row in rows):
        return StepResult(name, FAILED, reason=BILLING_NEEDS_REVIEW)
    if not rows:
        return StepResult(name, NOTHING_FOUND)
    return step_delete_rows(user_id, deps, "subscriptions")


def step_delete_user_row(user_id: str, deps: DeletionDeps) -> StepResult:
    name = "table_users"
    response = deps.db.table("users").delete().eq("id", user_id).execute()
    count = len(_rows(response))
    if _load_user(deps.db, user_id) is not None:
        raise _StepFailed("user row still present")
    return StepResult(name, DELETED if count else NOTHING_FOUND, count=count)


# ---------- orchestration ----------

def _run(report: DeletionReport, name: str, action: Callable[[], StepResult]) -> bool:
    try:
        result = action()
    except Exception as exc:  # noqa: BLE001 - any client/provider failure
        # Exception type only: messages can carry ids, paths or emails.
        logger.warning("Account deletion step failed step=%s error=%s", name, type(exc).__name__)
        report.steps.append(StepResult(name, FAILED))
        return False
    report.steps.append(result)
    logger.info("Account deletion step=%s outcome=%s count=%s", result.name, result.outcome, result.count)
    return True


def delete_account_data(user_id: str, deps: DeletionDeps) -> DeletionReport:
    """Delete or anonymize a student's data in a safe, re-runnable order.

    Stops before deleting the users row if any step fails, so the student can
    still sign in and try again; every step is safe to run twice.
    """
    report = DeletionReport()
    try:
        uid = _safe_user_id(user_id)
    except ValueError:
        report.steps.append(StepResult("validate_user", FAILED))
        logger.warning("Account deletion refused: unusable user id")
        return report
    if not deps.privileged_db:
        report.steps.append(StepResult("config", FAILED, reason="service-role key not configured"))
        logger.warning("Account deletion refused: database client is not using the service-role key")
        return report

    plan: list[tuple[str, Callable[[], StepResult]]] = [
        ("cancel_subscription", lambda: step_cancel_stripe(uid, deps)),
        # Early on purpose: a still-billable old subscription must stop deletion
        # before any study data is removed.
        ("table_old_subscriptions", lambda: step_delete_legacy_subscriptions(uid, deps)),
    ]
    for bucket, template in STORAGE_PREFIXES:
        plan.append((f"storage_{bucket}", lambda b=bucket, t=template: step_remove_storage(uid, deps, b, t)))
    plan.append(("notifications_actor", lambda: step_anonymize_actor(uid, deps)))
    for table in CHILD_TABLES:
        plan.append((f"table_{table}", lambda t=table: step_delete_rows(uid, deps, t)))
    for table in LEGACY_TOKEN_TABLES:
        plan.append((f"table_{table}", lambda t=table: step_delete_rows(uid, deps, t)))
    plan.append(("table_profiles", lambda: step_delete_rows(uid, deps, "profiles")))

    # Run every pre-step even after a failure: each is independent and
    # idempotent, so a retry has less left to do. The users row waits.
    all_ok = True
    for name, action in plan:
        all_ok = _run(report, name, action) and all_ok
        if report.needs_billing_review:
            # Keep everything (including profiles.subscription_status, the only
            # sign of a legacy subscription) until billing is resolved by hand.
            logger.warning("Account deletion paused: billing needs review; nothing else removed")
            return report

    if not all_ok:
        logger.warning("Account deletion incomplete; user row kept failed_steps=%s", ",".join(report.failed_steps))
        return report

    if not _run(report, "table_users", lambda: step_delete_user_row(uid, deps)):
        return report

    if deps.clear_memory is not None:
        # Best effort: the account is already gone, so a failure here must not
        # turn the answer into an error. These entries expire on their own.
        try:
            deps.clear_memory(uid)
            logger.info("Account deletion step=memory_state outcome=%s", DELETED)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Account deletion step=memory_state error=%s", type(exc).__name__)
    return report
