"""Static checks on the 2026-11-19 maintenance migration (no database needed).

The behaviour is proven on an in-memory Postgres by
backend/scripts/check_maintenance_migration.mjs; these tests only guard the file's text so
a later edit cannot quietly make it destructive.
"""

import re
from pathlib import Path

MIGRATION = Path(__file__).resolve().parents[1] / "app" / "schemas" / "migrations" / "2026_11_19_maintenance_state.sql"


def _sql() -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def test_file_exists_and_is_marked_not_applied():
    assert MIGRATION.is_file()
    assert "NOT APPLIED" in MIGRATION.read_text(encoding="utf-8").splitlines()[0]


def test_one_transaction():
    statements = [s.strip() for s in _sql().split(";") if s.strip()]
    assert statements[0] == "begin" and statements[-1] == "commit"
    assert "rollback" not in _sql()


def test_no_destructive_statements():
    sql = _sql()
    for pattern in (
        r"\bdrop\b",
        r"\btruncate\b",
        r"\bdelete\s+from\b",
        r"\brename\b",
        r"\balter\s+column\b",
        r"\bdisable\s+row\s+level\s+security\b",
        r"\bdisable\s+trigger\b",
        r"\bupdate\s+public\.",
    ):
        assert not re.search(pattern, sql), f"migration must stay additive; found {pattern}"


def test_only_new_tables_are_touched():
    sql = _sql()
    touched = re.findall(r"\b(?:alter\s+table|insert\s+into|create\s+table\s+if\s+not\s+exists)\s+public\.(\w+)", sql)
    assert touched
    for table in touched:
        assert table.startswith("maintenance_"), table
    assert len(re.findall(r"create\s+table\s+if\s+not\s+exists", sql)) == 4
    assert "create table public." not in sql  # always "if not exists"


def test_every_step_is_safe_to_repeat():
    sql = _sql()
    assert not re.search(r"add\s+column\s+(?!if\s+not\s+exists)", sql)
    assert not re.search(r"create\s+index\s+(?!if\s+not\s+exists)", sql)
    assert re.search(
        r"insert\s+into\s+public\.maintenance_state\s*\(id\)\s*values\s*\(1\)\s*on\s+conflict\s*\(id\)\s*do\s+nothing", sql
    )


def test_rls_on_for_every_new_table_and_no_public_access():
    sql = _sql()
    for table in ("maintenance_state", "maintenance_instances", "maintenance_jobs", "maintenance_log"):
        assert f"alter table public.{table} enable row level security" in sql
    assert "revoke all on table public.%i from anon" in sql
    assert "revoke all on table public.%i from authenticated" in sql
    assert "create policy" not in sql
    assert "to anon" not in sql and "to authenticated" not in sql


def test_fails_fast_instead_of_queueing_behind_locks():
    # Right after begin: a held lock or a long step rolls the whole file back (safe to rerun).
    statements = [" ".join(s.split()) for s in _sql().split(";") if s.strip()]
    assert statements[0] == "begin"
    assert statements[1] == "set local lock_timeout = '5s'"
    assert statements[2] == "set local statement_timeout = '120s'"
