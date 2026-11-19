"""Static checks on the monthly feedback migration file (no database needed).

Behaviour is proven on PGlite by backend/scripts/check_feedback_migration.mjs; these
tests only guard the text so a later edit can't quietly make it destructive or open.
"""

import re
from pathlib import Path

MIGRATION = Path(__file__).resolve().parents[1] / "app" / "schemas" / "migrations" / "2026_11_18_monthly_feedback.sql"
TABLES = (
    "feedback_polls", "feedback_questions", "feedback_responses", "feedback_answers", "feedback_skips",
    "feedback_comment_themes", "feedback_theme_members", "feedback_admin_updates",
)


def sql() -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def test_header_says_not_applied():
    head = MIGRATION.read_text(encoding="utf-8").splitlines()[:3]
    assert any("NOT APPLIED" in line for line in head)


def test_one_transaction():
    statements = [s.strip() for s in re.sub(r"\$\$.*?\$\$", "$$", sql(), flags=re.S).split(";") if s.strip()]
    assert statements[0] == "begin" and statements[-1] == "commit"
    assert "rollback" not in sql()


def test_additive_only():
    body = re.sub(r"\$\$.*?\$\$", "$$", sql(), flags=re.S)  # function bodies may delete their own rows
    for pattern in (r"\bdrop\b", r"\btruncate\b", r"\bdelete\s+from\b", r"\brename\b", r"\balter\s+table\s+public\.(?!feedback_)",
                    r"\bdisable\s+row\s+level\s+security\b", r"\bdisable\s+trigger\b", r"\bupdate\s+public\.(?!feedback_)"):
        assert not re.search(pattern, body), pattern


def test_every_table_has_rls_and_no_policies():
    text = sql()
    for table in TABLES:
        assert f"create table if not exists public.{table}" in text
        assert f"alter table public.{table} enable row level security;" in text
    assert "create policy" not in text


def test_one_vote_per_account_and_per_email():
    text = sql()
    assert "unique (poll_id, user_id)" in text and "unique (poll_id, voter_key)" in text
    assert "references public.users (id) on delete set null" in text  # answers stay without the name


def test_grants_are_minimal():
    text = sql()
    assert "revoke all on table public.%i from anon" in text and "revoke all on table public.%i from authenticated" in text
    assert "revoke all on table public.%i from service_role" in text
    # Ballots are written only through feedback_submit (security definer): no direct insert.
    assert "grant select on table public.feedback_responses to service_role" in text
    assert "grant select on table public.feedback_answers to service_role" in text
    assert not re.search(r"grant[^;]*insert[^;]*on table public\.feedback_(responses|answers) to service_role", text)
    assert re.search(r"function public\.feedback_submit\(.*?language plpgsql security definer set search_path = public, pg_temp", text, re.S)
    assert not re.search(r"grant[^;]*to (anon|authenticated)", text)
    assert "revoke execute on function public.%s from public" in text


def test_comment_limit_matches_the_backend():
    from app import feedback_text

    assert f"between 1 and {feedback_text.COMMENT_MAX}" in sql()
