"""A Luma-shaped database full of FAKE rows, in a local cluster on 127.0.0.1 (tests and rehearsal).

Tables come from backend/scripts/fixtures/live_shape_2026_11_15.json (the same builder as
backend/scripts/check_live_migration.mjs), then the migration files are applied in name order.
Every email ends in @example.test and every text holds a marker so tests can prove that
nothing readable leaks into encrypted files, manifests or logs.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .pgtools import LocalCluster, PgTools
from .restore_test import ROLES_SQL, SUPABASE_STUBS_SQL

REPO = Path(__file__).resolve().parents[3]
SHAPE_FILE = REPO / "backend" / "scripts" / "fixtures" / "live_shape_2026_11_15.json"
MIGRATIONS_DIR = REPO / "backend" / "app" / "schemas" / "migrations"
GUARD_FILE = REPO / "backend" / "app" / "schemas" / "password_hash_guard.sql"

# Migrations treated as already live for the rehearsal (design A.10 step 6).
LIVE_MIGRATIONS_UPTO = "2026_11_15"

MARKER = "SYNTH-MARKER-7f3a"
FAKE_ARGON = "$argon2id$v=19$m=65536,t=3,p=4$c3ludGhzYWx0$ZmFrZWZha2VmYWtlaGFzaA"

# Copied from check_live_migration.mjs: the search triggers ASSUMED to exist live.
LEGACY_SEARCH_TRIGGERS = """
create or replace function public.notes_search_vector_trigger() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.title, '') || ' ' || coalesce(new.content, '') || ' ' || coalesce(array_to_string(new.tags, ' '), ''));
  return new;
end; $$;
create or replace function public.flashcards_search_vector_trigger() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.front, '') || ' ' || coalesce(new.back, '') || ' ' || coalesce(array_to_string(new.tags, ' '), ''));
  return new;
end; $$;
create or replace function public.summaries_search_vector_trigger() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.content, ''));
  return new;
end; $$;
create or replace function public.transcripts_search_vector_trigger() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.content, ''));
  return new;
end; $$;
create trigger notes_search_update before insert or update on public.notes for each row execute function public.notes_search_vector_trigger();
create trigger flashcards_search_update before insert or update on public.flashcards for each row execute function public.flashcards_search_vector_trigger();
create trigger summaries_search_update before insert or update on public.summaries for each row execute function public.summaries_search_vector_trigger();
create trigger transcripts_search_update before insert or update on public.transcripts for each row execute function public.transcripts_search_vector_trigger();
"""


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _literal(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def column_sql(name: str, col: dict) -> str:
    """Port of columnSql() in check_live_migration.mjs."""
    parts = [_ident(name), col["format"]]
    d = col.get("default")
    if d is not None:
        if isinstance(d, bool):
            parts.append(f"default {'true' if d else 'false'}")
        elif isinstance(d, (int, float)):
            parts.append(f"default {d}")
        elif "(" in d:
            parts.append(f"default {d}")
        else:
            parts.append(f"default {_literal(d)}")
    if col.get("required") and not col.get("pk"):
        parts.append("not null")
    if col.get("fk"):
        m = re.search(r"table='(\w+)' column='(\w+)'", col["fk"])
        parts.append(f"references public.{_ident(m.group(1))}({_ident(m.group(2))})")
    return " ".join(parts)


def table_sql(shape: dict, table: str) -> str:
    """Port of tableSql() in check_live_migration.mjs."""
    cols = shape[table]
    defs = [column_sql(n, c) for n, c in cols.items()]
    pk = [_ident(n) for n, c in cols.items() if c.get("pk")]
    if pk:
        defs.append(f"primary key ({', '.join(pk)})")
    return f"create table public.{_ident(table)} (\n  " + ",\n  ".join(defs) + "\n);"


def load_shape() -> dict:
    return json.loads(SHAPE_FILE.read_text(encoding="utf-8"))["tables"]


def migration_files(upto: str | None = None, after: str | None = None) -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda p: p.name)
    if upto is not None:
        files = [f for f in files if f.name[: len(upto)] <= upto]
    if after is not None:
        files = [f for f in files if f.name[: len(after)] > after]
    return files


def _uid(n: int) -> str:
    return f"{n:08d}-0000-4000-8000-{n:012d}"


def seed_sql() -> str:
    m = MARKER
    users, profiles = [], []
    for i in range(1, 6):
        pw = f"'legacy-plain-{i}'" if i <= 3 else _literal(FAKE_ARGON)
        ph = "null" if i <= 3 else _literal(FAKE_ARGON)
        users.append(f"('{_uid(i)}', 'student{i}@example.test', 'student{i}', 'user', {pw}, {ph}, true)")
        profiles.append(f"('{_uid(i)}', 'student{i}', 'Student {i} {m}', 'America/Chicago')")
    notes = [f"(gen_random_uuid(), '{_uid(1 + i % 5)}', 'Note {i} {m}', 'Body {i} {m} photosynthesis', "
             f"'{{biology}}')" for i in range(6)]
    cards = [f"(gen_random_uuid(), '{_uid(1 + i % 5)}', 'Front {i} {m}', 'Back {i}', '{{}}')" for i in range(4)]
    return f"""
insert into public.users (id, email, username, role, password, password_hash, email_verified) values
{",".join(users)};
insert into public.profiles (user_id, username, display_name, timezone) values
{",".join(profiles)};
insert into public.notes (id, user_id, title, content, tags) values {",".join(notes)};
insert into public.flashcards (id, user_id, front, back, tags) values {",".join(cards)};
insert into public.summaries (id, user_id, content) values
 (gen_random_uuid(), '{_uid(1)}', 'Summary {m} one'), (gen_random_uuid(), '{_uid(2)}', 'Summary {m} two');
insert into public.study_sessions (id, user_id, name, duration_seconds) values
 (gen_random_uuid(), '{_uid(1)}', 'Session {m}', 600), (gen_random_uuid(), '{_uid(3)}', 'Session two', 0);
insert into public.transcripts (id, user_id, content) values (gen_random_uuid(), '{_uid(2)}', 'Transcript {m}');
insert into public.notifications (id, user_id, message) values
 (gen_random_uuid(), '{_uid(1)}', 'Hello {m}'), (gen_random_uuid(), '{_uid(2)}', 'Hi'),
 (gen_random_uuid(), '{_uid(4)}', 'Welcome');
insert into public.ai_usage (id, user_id, feature, tokens_used) values
 (gen_random_uuid(), '{_uid(1)}', 'notes', 12), (gen_random_uuid(), '{_uid(5)}', 'chat', 0);
"""


SEEDED_COUNTS = {"users": 5, "profiles": 5, "notes": 6, "flashcards": 4, "summaries": 2, "study_sessions": 2,
                 "transcripts": 1, "notifications": 3, "ai_usage": 2}
# Rows the migrations themselves create (not seeded by this module). The maintenance migration
# adds its one settings row; a backup must keep it like any other row.
MIGRATION_ROWS = {"maintenance_state": 1}
LEGACY_PLAINTEXT_ROWS = 3


def build(tools: PgTools, base_dir: Path, port: int, migrations: list[Path] | None = None,
          install_guard: bool = True) -> LocalCluster:
    """initdb + start a source cluster and fill database 'postgres' with fake Luma data."""
    cluster = LocalCluster(tools, base_dir, port)
    cluster.init()
    cluster.start()
    conn = cluster.conn("postgres")
    shape = load_shape()
    order = ["users", "profiles", *[t for t in shape if t not in ("users", "profiles")]]
    tools.psql(conn, ROLES_SQL + SUPABASE_STUBS_SQL +
               "insert into storage.buckets (id, name, public, created_at) "
               "values ('avatars', 'avatars', true, '2025-01-01T00:00:00Z');\n")
    tools.psql(conn, "\n".join(table_sql(shape, t) for t in order) + LEGACY_SEARCH_TRIGGERS)
    for path in migration_files() if migrations is None else migrations:
        tools.psql(conn, path.read_text(encoding="utf-8"), timeout=600)
    tools.psql(conn, seed_sql())
    if install_guard:
        tools.psql(conn, GUARD_FILE.read_text(encoding="utf-8"))
    return cluster


def secrets_dict(cluster: LocalCluster, storage_url: str, storage_key: str, passphrase: str,
                 passphrase_id: str = "lb-test-a") -> dict:
    conn = cluster.conn("postgres")
    return {
        "db": {"host": conn["host"], "port": conn["port"], "user": conn["user"], "dbname": conn["dbname"],
               "password": conn["password"], "sslmode": "disable"},
        "storage": {"url": storage_url, "service_key": storage_key},
        "passphrase": passphrase,
        "passphrase_id": passphrase_id,
        "old_passphrases": {},
        "created_at": "2026-11-18T00:00:00Z",
    }
