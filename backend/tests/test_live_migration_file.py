"""Static checks on the 2026-11-15 live migration file (no database needed).

The behaviour is proven on an in-memory Postgres by
backend/scripts/check_live_migration.mjs; these tests only guard the file's text
so a later edit cannot quietly make it destructive.
"""

import re
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "app"
    / "schemas"
    / "migrations"
    / "2026_11_15_bring_live_up_to_date.sql"
)


def _sql_without_comments() -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def test_file_exists():
    assert MIGRATION.is_file()


def test_single_transaction_begin_and_commit():
    sql = _sql_without_comments()
    statements = [s.strip() for s in sql.split(";") if s.strip()]
    assert statements[0] == "begin"
    assert statements[-1] == "commit"
    assert len(re.findall(r"^\s*begin\s*;", sql, flags=re.M)) == 1
    assert len(re.findall(r"^\s*commit\s*;", sql, flags=re.M)) == 1
    assert "rollback" not in sql


def test_no_destructive_statements():
    sql = _sql_without_comments()
    for pattern in (
        r"\bdrop\b",
        r"\btruncate\b",
        r"\bdelete\s+from\b",
        r"\brename\b",
        r"\balter\s+column\s+\w+\s+(set\s+data\s+)?type\b",
        r"\bdisable\s+row\s+level\s+security\b",
        r"\bdisable\s+trigger\b",
    ):
        assert not re.search(pattern, sql), f"migration must stay additive; found {pattern}"


def test_does_not_install_password_guard():
    sql = _sql_without_comments()
    assert "luma_password_hash_guard" not in sql
    assert "luma_reject_plaintext_password" not in sql
    assert "luma_password_guard_installed" not in sql
    # The pointer to the guard and its rollout order stays in the header.
    assert "password_hash_guard.sql" in MIGRATION.read_text(encoding="utf-8")


def test_does_not_backfill_billing_from_legacy_subscriptions():
    sql = _sql_without_comments()
    for match in re.finditer(r"insert\s+into\s+([\w.\"]+)(.*?);", sql, flags=re.S):
        target, rest = match.group(1), match.group(2)
        assert "billing" not in target, "billing links are written only by the Stripe webhook or by hand"
        assert "subscriptions" not in rest
    # public.subscriptions is read in exactly one place: the one-time
    # profiles.subscription_status backfill, which only sets 'premium' on the
    # row's own account so the billing_needs_review gate applies.
    reads = re.findall(r"\bfrom\s+(?:public\.)?subscriptions\b", sql)
    assert len(reads) == 1
    backfill = re.search(
        r"update\s+public\.profiles\s+p\s+set\s+subscription_status\s*=\s*'premium'\s+where\s+exists\s*\(\s*"
        r"select\s+1\s+from\s+public\.subscriptions\s+s\s+where\s+s\.user_id\s*=\s*p\.user_id",
        sql,
    )
    assert backfill, "legacy subscriptions may only mark their own account's profile as premium"


def test_legacy_premium_backfill_runs_only_when_column_is_added():
    sql = _sql_without_comments()
    update_at = sql.index("set subscription_status = 'premium'")
    block_start = sql.rindex("do $$", 0, update_at)
    block = sql[block_start : sql.index("$$;", update_at)]
    assert "if not exists" in block
    assert block.index("add column subscription_status") < block.index("update public.profiles")


def test_existing_rls_untouched():
    sql = _sql_without_comments()
    enabled = set(re.findall(r"alter\s+table\s+([\w.]+)\s+enable\s+row\s+level\s+security", sql))
    assert enabled == {"public.analytics_events", "public.billing_accounts", "public.billing_subscriptions"}
    assert "create policy" not in sql and "alter policy" not in sql
