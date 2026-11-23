"""Static checks on the 2026-11-24 subjects migration file (no database needed).

The behaviour is proven on an in-memory Postgres by backend/scripts/check_subjects_migration.mjs;
these tests only guard the file's text so a later edit cannot quietly make it destructive,
non-repeatable or open to anyone but the API.
"""

import re
from pathlib import Path

MIGRATION = Path(__file__).resolve().parents[1] / "app" / "schemas" / "migrations" / "2026_11_24_subjects.sql"
SIGNATURE = "public.public_study_search(text, jsonb, text, text, text, uuid[], integer, integer)"


def _text() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def _sql_without_comments() -> str:
    text = re.sub(r"/\*.*?\*/", " ", _text(), flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def _statements() -> list[str]:
    return [" ".join(s.split()) for s in _sql_without_comments().split(";") if s.strip()]


def test_file_exists_and_says_not_applied():
    assert MIGRATION.is_file()
    assert "NOT APPLIED" in _text().splitlines()[0]


def test_one_transaction_with_fail_fast_timeouts():
    statements = _statements()
    assert statements[0] == "begin"
    assert statements[1] == "set local lock_timeout = '5s'"
    assert statements[2] == "set local statement_timeout = '120s'"
    assert "commit" in statements


def test_no_destructive_statements():
    sql = _sql_without_comments()
    for pattern in (
        r"\bdrop\b",
        r"\btruncate\b",
        r"\bdelete\s+from\b",
        r"\bupdate\s+public\.",
        r"\binsert\s+into\b",
        r"\brename\b",
        r"\balter\s+column\b",
        r"\btype\s+(text|integer|bigint|uuid)\b.*\busing\b",
        r"\bdisable\s+row\s+level\s+security\b",
        r"\bdisable\s+trigger\b",
        r"\bsecurity\s+definer\b",
        r"\bcreate\s+extension\b",
    ):
        assert not re.search(pattern, sql), f"migration must stay additive; found {pattern}"


def test_exact_columns_are_nullable_text_and_repeatable():
    added = set()
    for statement in _statements():
        if " add column " in statement:
            assert " add column if not exists " in statement, statement
            match = re.match(r"alter table public\.(\w+) add column if not exists (\w+) (.+)$", statement)
            assert match, statement
            added.add((match.group(1), match.group(2), match.group(3)))
    assert added == {(t, c, "text") for t in ("notes", "flashcards", "summaries") for c in ("subject_slug", "subtopic_slug")}


def test_checks_are_added_not_valid_then_validated_and_only_once():
    sql = _sql_without_comments()
    assert sql.count("not valid") == 2
    assert sql.count("validate constraint") == 2
    assert "if not exists (select 1 from pg_constraint" in sql


def test_indexes_are_partial_on_shared_rows_and_repeatable():
    indexes = [s for s in _statements() if s.startswith("create index") or s.startswith("create unique index")]
    assert len(indexes) == 3
    for statement in indexes:
        assert statement.startswith("create index if not exists ")
        assert statement.endswith("(subject_slug, subtopic_slug, published_at desc) where is_public")


def test_the_search_is_read_only_and_only_the_service_role_may_run_it():
    sql = _sql_without_comments()
    assert "create or replace function public.public_study_search(" in sql
    assert "language sql stable security invoker set search_path = public, pg_temp" in sql
    sig = SIGNATURE.lower()
    assert f"revoke execute on function {sig} from public" in sql
    assert f"revoke execute on function {sig} from anon" in sql
    assert f"revoke execute on function {sig} from authenticated" in sql
    assert f"grant execute on function {sig} to service_role" in sql
    assert not re.search(r"grant[^;']*to (anon|authenticated|public)\b", sql)
    # It reads shared rows only, and never the stored published_by name.
    assert sql.count("is_public and btrim(coalesce(") == 3
    assert "published_by" not in sql


def test_a_guard_stops_the_file_when_anything_is_not_as_expected():
    sql = _sql_without_comments()
    assert "do $guard$" in sql
    for message in ("subject columns are not as expected", "subject checks are not as expected",
                    "subject indexes are not as expected", "public_study_search is not as expected"):
        assert message in sql


def test_reloads_the_api_schema_and_has_a_read_only_verify_section():
    text = _text()
    assert "notify pgrst, 'reload schema';" in text
    verify = text.split("-- VERIFY", 1)[1]
    assert all(line.startswith("--") for line in verify.splitlines()[1:] if line.strip())
