"""Static checks on the 2026-11-19 student-work migration file (no database needed).

The behaviour is proven on an in-memory Postgres by
backend/scripts/check_student_work_migration.mjs; these tests only guard the file's text
so a later edit cannot quietly make it destructive or non-repeatable.
"""

import re
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "app"
    / "schemas"
    / "migrations"
    / "2026_11_19_student_work_versions.sql"
)


def _sql_without_comments() -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def _statements() -> list[str]:
    return [" ".join(s.split()) for s in _sql_without_comments().split(";") if s.strip()]


def test_file_exists_and_says_not_applied():
    assert MIGRATION.is_file()
    assert "NOT APPLIED" in MIGRATION.read_text(encoding="utf-8").splitlines()[0]


def test_no_destructive_statements():
    sql = _sql_without_comments()
    for pattern in (
        r"\bdrop\b",
        r"\btruncate\b",
        r"\bdelete\s+from\b",
        r"\bupdate\s+public\.",
        r"\brename\b",
        r"\balter\s+column\b",
        r"\bdisable\s+row\s+level\s+security\b",
        r"\bdisable\s+trigger\b",
        r"\bgrant\b",
        r"\brevoke\b",
    ):
        assert not re.search(pattern, sql), f"migration must stay additive; found {pattern}"


def test_every_add_column_is_repeatable_and_safe():
    adds = [s for s in _statements() if " add column " in s]
    assert len(adds) == 9
    for statement in adds:
        assert " add column if not exists " in statement, statement
        if "not null" in statement:
            assert re.search(r"\bdefault\s+\d+\b", statement), f"a NOT NULL column needs a default: {statement}"


def test_exact_columns():
    added = set()
    for statement in _statements():
        match = re.match(r"alter table public\.(\w+) add column if not exists (\w+) (.+)$", statement)
        if match:
            added.add((match.group(1), match.group(2), match.group(3)))
    assert added == {
        ("notes", "version", "bigint not null default 1"),
        ("notes", "create_key", "uuid"),
        ("summaries", "version", "bigint not null default 1"),
        ("summaries", "create_key", "uuid"),
        ("flashcards", "version", "bigint not null default 1"),
        ("flashcards", "create_key", "uuid"),
        ("flashcards", "progress_rev", "bigint not null default 0"),
        ("study_sessions", "version", "bigint not null default 1"),
        ("study_sessions", "create_key", "uuid"),
    }


def test_unique_indexes_are_per_user_partial_and_repeatable():
    indexes = [s for s in _statements() if s.startswith("create")]
    assert len(indexes) == 4
    for table in ("notes", "summaries", "flashcards", "study_sessions"):
        expected = (
            f"create unique index if not exists {table}_user_create_key_uidx on public.{table} "
            "(user_id, create_key) where create_key is not null"
        )
        assert expected in indexes


def test_one_transaction_then_schema_reload():
    statements = _statements()
    assert statements[0] == "begin"
    assert statements[-2] == "commit"
    assert statements[-1] == "notify pgrst, 'reload schema'"
    assert "rollback" not in _sql_without_comments()
