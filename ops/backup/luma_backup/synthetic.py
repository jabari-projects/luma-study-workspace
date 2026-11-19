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

# The last migration already applied to production. The release rehearsal builds this shape and
# applies every later file (design A.10 step 6; docs/deployment-checklist.md uses --after 2026_11_17).
LIVE_MIGRATIONS_UPTO = "2026_11_17"

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


# ------------------------------------------------------------------ production-shaped seed

# Fake accounts for the production-shaped database (rehearsal of a release on "live" data).
PRODUCTION_ACCOUNTS = 12
_FAKE_NAMES = ["Ava Chen", "Liam O'Brien", "Sofía Martínez", "Noah Kim", "Zoë Müller", "Ethan Patel",
               "Mia Johnson", "Lucas Rossi", "Aanya Gupta", "Kai Nakamura", 'Olivia "Liv" Brown', "Mateo García"]


def production_seed_sql() -> str:
    """Realistic FAKE rows for every table production has (live shape + migrations up to
    LIVE_MIGRATIONS_UPTO): accounts with profiles, notes, flashcard decks whose cards carry review
    progress, summaries, study plans, shared (public) items, reports, email codes, AI allowance
    rows and billing rows. Values include the awkward ones (quotes, backslashes, newlines, tabs,
    accents, emoji, CJK, long text, empty strings, NULLs, microsecond times, fractional numbers),
    so a byte-level comparison has something to catch.
    """
    m = MARKER
    users, profiles = [], []
    modes = ["light", "dark", "system", None]
    for i in range(1, PRODUCTION_ACCOUNTS + 1):
        uid, name = _uid(i), _FAKE_NAMES[i - 1]
        email = "Kai.Nakamura@example.test" if i == 10 else f"student{i}@example.test"
        pw = _literal("legacy-plain-12") if i == 12 else _literal(FAKE_ARGON)
        ph = "null" if i == 12 else _literal(FAKE_ARGON)
        verified = "false" if i % 4 == 0 else "true"
        role = "'admin'" if i == 1 else "'user'"
        token = f"'verify-token-{i}'" if i % 4 == 0 else "null"
        created = f"timestamptz '2026-08-01 09:00:00.123456+00' + interval '{i} days 3 hours'"
        users.append(f"('{uid}', {_literal(email)}, 'student{i}', {role}, {pw}, {ph}, {verified}, "
                     f"{'true' if i == 1 else 'false'}, {token}, {created}, "
                     f"{'null' if i % 5 else _literal('midnight')})")
        mode = modes[i % 4]
        profiles.append(
            f"('{uid}', 'student{i}', {_literal(name + ' ' + m)}, "
            f"{_literal(f'avatars/{uid}/face.png') if i % 3 == 0 else 'null'}, "
            f"{_literal(['ocean', 'forest', 'sunset'][i % 3])}, "
            f"{_literal(f'themes/{uid}/top.png') if i == 7 else 'null'}, "
            f"{_literal(['America/Chicago', 'Europe/Madrid', 'Asia/Tokyo'][i % 3])}, "
            f"{_literal(mode) if mode else 'null'}, null, {_literal(f'2010-0{1 + i % 9}-1{i % 10}')}, "
            f"{created}, {role}, {_literal('premium') if i in (2, 5) else _literal('free')})")
    u = "(select id, substr(id::text, 1, 8)::int as n, username from public.users)"
    nl = "chr(10)"
    return f"""
insert into public.users (id, email, username, role, password, password_hash, email_verified, is_admin,
  verification_token, created_at, theme_color) values
{",".join(users)};
insert into public.profiles (user_id, username, display_name, avatar_url, theme_color, custom_theme_image_url,
  timezone, theme_mode, phone_number, birthday, created_at, role, subscription_status) values
{",".join(profiles)};

-- Notes: 4 per account, every 3rd account shares its first note, plus one orphaned legacy note.
insert into public.notes (user_id, title, content, tags, created_at, updated_at, is_public, published_at,
  published_by, study_type)
select u.id,
  case g when 1 then format('Photosynthesis %s %s', u.n, '{m}') when 2 then format('French Revolution %s', u.n)
         when 3 then format('Ecuación «%s» 🧪', u.n) else '' end,
  case g
    when 1 then 'Light reactions & the Calvin cycle {m}' || {nl} || 'Key terms: chlorophyll, ATP — "light" vs ''dark'''
    when 2 then repeat('The Estates-General met in 1789; the Third Estate formed the National Assembly. ', 250)
    when 3 then 'x² + y² = r² · π ≈ 3.14159 — 日本語のノート' || chr(9) || 'tab \\ backslash 🙂'
    else '' end,
  case g when 1 then '{{biology,science}}'::text[] when 2 then '{{}}'::text[]
         when 3 then array['math, geometry', 'quote''s', 'ünïcode'] else '{{history}}'::text[] end,
  timestamp '2026-09-01 08:15:30.123456' + make_interval(days => u.n, hours => g),
  timestamptz '2026-10-01 08:15:30.654321+00' + make_interval(days => u.n, mins => g),
  g = 1 and u.n % 3 = 0,
  case when g = 1 and u.n % 3 = 0 then timestamptz '2026-10-05 12:00:00+00' + make_interval(days => u.n) end,
  case when g = 1 and u.n % 3 = 0 then u.username end,
  'note'
from {u} u cross join generate_series(1, 4) g;
insert into public.notes (user_id, title, content, tags) values (null, 'Orphaned note {m}', 'kept as is', '{{}}');

-- Flashcard decks: 3 per account. Cards carry FSRS review progress (or none yet); deck 3 is a
-- legacy single-card row with no cards array. Every 4th account shares deck 1.
insert into public.flashcards (user_id, front, back, tags, created_at, updated_at, title, cards, is_public,
  published_at, published_by, study_type)
select u.id, format('Front %s.%s {m}', u.n, g), format('Back %s.%s', u.n, g),
  case g when 2 then '{{chemistry}}'::text[] else '{{}}'::text[] end,
  timestamp '2026-09-10 10:00:00.5' + make_interval(days => u.n, hours => g),
  timestamptz '2026-11-01 07:30:00.000001+00' + make_interval(days => u.n),
  case g when 3 then null else format('Deck %s.%s — Cells & Energy 🔋', u.n, g) end,
  case g when 3 then '[]'::jsonb else jsonb_build_array(
    jsonb_build_object('id', md5(u.id::text || g || 'a'), 'front', 'Mitochondria', 'back', 'Powerhouse of the cell',
      'review', jsonb_build_object('due', '2026-11-20T08:00:00.000Z', 'stability', 3.17421 + u.n,
        'difficulty', 5.2918, 'elapsed_days', 2, 'scheduled_days', 3, 'learning_steps', 0, 'reps', 4 + g,
        'lapses', 1, 'state', 2, 'last_review', '2026-11-17T08:00:00.000Z')),
    jsonb_build_object('id', md5(u.id::text || g || 'b'), 'front', 'ATP', 'back', 'Adenosine "tri" phosphate',
      'review', jsonb_build_object('due', '2026-11-19T21:45:10.250Z', 'stability', 0.40255, 'difficulty', 7.1,
        'elapsed_days', 0, 'scheduled_days', 0, 'learning_steps', 1, 'reps', 1, 'lapses', 0, 'state', 1,
        'last_review', null)),
    jsonb_build_object('id', md5(u.id::text || g || 'c'), 'front', '光合作用', 'back', 'photosynthesis', 'review', null),
    jsonb_build_object('id', md5(u.id::text || g || 'd'), 'front', 'Back\\slash', 'back', 'line one' || {nl} || 'line two'))
  end,
  g = 1 and u.n % 4 = 0,
  case when g = 1 and u.n % 4 = 0 then timestamptz '2026-11-02 09:00:00+00' end,
  case when g = 1 and u.n % 4 = 0 then u.username end,
  'flashcards'
from {u} u cross join generate_series(1, 3) g;

-- Summaries: 2 per account (one made from a note); account 5 shares one.
insert into public.summaries (user_id, content, created_at, source_type, source_id, title, tags, updated_at,
  is_public, published_at, published_by, study_type)
select u.id, case g when 1 then format('Summary %s {m}: cells make energy.', u.n) else 'Short.' || {nl} || '- point' end,
  timestamp '2026-10-10 11:11:11.111111' + make_interval(days => u.n),
  case g when 1 then 'note' end, case g when 1 then md5(u.id::text)::uuid end,
  case g when 1 then format('Summary of note %s', u.n) end,
  case g when 1 then '{{biology}}'::text[] else '{{}}'::text[] end,
  case g when 1 then timestamptz '2026-10-11 00:00:00+00' end,
  g = 1 and u.n = 5, case when g = 1 and u.n = 5 then timestamptz '2026-10-12 00:00:00+00' end,
  case when g = 1 and u.n = 5 then u.username end, 'summary'
from {u} u cross join generate_series(1, 2) g;

-- Study plans: 2 per account.
insert into public.study_sessions (user_id, name, subject, notes, duration_seconds, created_at, updated_at)
select u.id, format('Plan %s.%s {m}', u.n, g), case g when 1 then 'Biology' end,
  case g when 1 then 'Chapters 3–4, then flashcards' else null end, case g when 1 then 2700 else 0 end,
  timestamp '2026-10-20 16:00:00' + make_interval(days => u.n, hours => g),
  timestamptz '2026-10-20 16:00:00+00' + make_interval(days => u.n)
from {u} u cross join generate_series(1, 2) g;

insert into public.transcripts (user_id, content, source, created_at, updated_at)
select u.id, format('Transcript %s {m}: today we cover mitosis.', u.n), case when u.n % 2 = 0 then 'upload' end,
  timestamp '2026-10-25 09:30:00' + make_interval(days => u.n), timestamptz '2026-10-25 09:30:00+00'
from {u} u;

insert into public.notifications (user_id, message, read, created_at, type, actor_user_id, payload)
select u.id, case g when 1 then 'Welcome to Luma {m}' else '' end, g = 2,
  timestamptz '2026-11-01 00:00:00+00' + make_interval(days => u.n, hours => g), 'system',
  case when g = 2 and u.n > 1 then '{_uid(1)}'::uuid end,
  case g when 1 then jsonb_build_object('message', 'Welcome to Luma {m}') else null end
from {u} u cross join generate_series(1, 2) g;

insert into public.ai_usage (user_id, feature, tokens_used, created_at, type)
select u.id, (array['notes', 'chat', 'ai'])[g], u.n * 100 + g, timestamptz '2026-11-05 12:00:00+00' + make_interval(days => g),
  (array['notes', 'transcription', null])[g]
from {u} u cross join generate_series(1, 3) g;

insert into public.analytics_events (user_id, event_name, event_group, page_path, feature_key, subscription_tier,
  surface, metadata, created_at)
select u.id, (array['page_view', 'deck_studied', 'note_saved', 'search', 'theme_changed'])[g],
  (array['navigation', 'study', 'notes', 'search', 'settings'])[g], format('/study/%s', g),
  case when g > 1 then 'feature_' || g end, case when u.n in (2, 5) then 'premium' else 'free' end, 'web',
  jsonb_build_object('n', u.n, 'ratio', 0.1 + g * 0.05, 'nested', jsonb_build_object('ok', true)),
  timestamptz '2026-11-10 00:00:00.000123+00' + make_interval(hours => u.n * 5 + g)
from {u} u cross join generate_series(1, 5) g;
insert into public.analytics_events (user_id, event_name, event_group, metadata)
select null, 'landing_view', 'navigation', '{{}}'::jsonb from generate_series(1, 3);

-- Billing: new link tables for 4 accounts, legacy subscriptions for 3.
insert into public.billing_accounts (user_id, stripe_customer_id, created_at, updated_at) values
 ('{_uid(2)}', 'cus_TESTfake0002', '2026-09-01 00:00:00+00', '2026-11-01 00:00:00+00'),
 ('{_uid(5)}', 'cus_TESTfake0005', '2026-09-02 00:00:00+00', '2026-11-02 00:00:00+00'),
 ('{_uid(7)}', 'cus_TESTfake0007', '2026-09-03 00:00:00+00', '2026-11-03 00:00:00+00'),
 ('{_uid(9)}', null, '2026-09-04 00:00:00+00', '2026-11-04 00:00:00+00');
insert into public.billing_subscriptions (stripe_subscription_id, user_id, stripe_customer_id, status,
  current_period_end, updated_at) values
 ('sub_TESTfake0002', '{_uid(2)}', 'cus_TESTfake0002', 'active', '2026-12-01 00:00:00+00', '2026-11-01 00:00:00+00'),
 ('sub_TESTfake0005', '{_uid(5)}', 'cus_TESTfake0005', 'past_due', '2026-11-25 00:00:00+00', '2026-11-02 00:00:00+00'),
 ('sub_TESTfake0007', '{_uid(7)}', 'cus_TESTfake0007', 'canceled', null, '2026-11-03 00:00:00+00'),
 ('sub_TESTfake0071', '{_uid(7)}', 'cus_TESTfake0007', 'incomplete_expired', '2026-10-01 00:00:00+00', '2026-10-01 00:00:00+00');
insert into public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end) values
 ('{_uid(3)}', 'cus_TESTlegacy03', 'sub_TESTlegacy03', 'canceled', '2026-06-01 00:00:00+00'),
 ('{_uid(5)}', 'cus_TESTlegacy05', 'sub_TESTlegacy05', 'active', '2026-12-05 00:00:00+00'),
 ('{_uid(8)}', null, null, null, null);

-- Email codes: open, used and replaced codes for accounts, plus pending signups (no account yet).
insert into public.email_codes (user_id, purpose, email, code_digest, created_at, expires_at, attempts,
  consumed_at, superseded_at)
select u.id, 'verify_email', lower(x.email), md5('code' || u.n || g),
  timestamptz '2026-11-18 10:00:00+00' + make_interval(mins => g), timestamptz '2026-11-18 10:15:00+00' + make_interval(mins => g),
  g - 1, case when g = 2 then timestamptz '2026-11-18 10:05:00+00' end,
  case when g = 1 then timestamptz '2026-11-18 10:02:00+00' end
from {u} u join public.users x on x.id = u.id cross join generate_series(1, 2) g where u.n % 4 = 0;
insert into public.email_codes (user_id, purpose, email, code_digest, ticket_digest, pending_username,
  pending_password_hash, expires_at, attempts) values
 (null, 'signup', 'newstudent1@example.test', md5('s1'), md5('t1'), 'newstudent1', '{FAKE_ARGON}', '2026-11-19 10:00:00+00', 0),
 (null, 'signup', 'newstudent2@example.test', md5('s2'), md5('t2'), 'new_student_2', '{FAKE_ARGON}', '2026-11-19 11:00:00+00', 3),
 (null, 'signup', 'newstudent3@example.test', md5('s3'), md5('t3'), null, '{FAKE_ARGON}', '2026-11-17 11:00:00+00', 5);

insert into public.ai_allowance_usage (email_key, day, usage_type, used)
select encode(sha256(convert_to('fake-secret:' || lower(x.email), 'UTF8')), 'hex'), date '2026-11-17' + d,
  t, (u.n + d) % 4
from {u} u join public.users x on x.id = u.id cross join generate_series(0, 1) d
  cross join unnest(array['notes', 'transcription']) t;

-- Reports about shared items (one from an account that was later deleted: reporter null).
insert into public.content_reports (item_type, item_id, item_title, reason, details, reporter_id, status, created_at,
  reviewed_at, reviewer_note)
select (array['note', 'flashcards', 'summary'])[1 + g % 3], md5('item' || g), format('Shared item %s {m}', g),
  (array['bullying', 'unsafe', 'private_info', 'spam', 'copyright', 'wrong_info', 'other'])[1 + g % 7],
  case when g % 2 = 0 then 'Has a phone number in it' end,
  case when g = 6 then null else '{_uid(2)}'::uuid end,
  (array['open', 'reviewing', 'resolved', 'dismissed'])[1 + g % 4],
  timestamptz '2026-11-17 13:00:00+00' + make_interval(hours => g),
  case when g % 4 >= 2 then timestamptz '2026-11-18 09:00:00+00' end,
  case when g % 4 = 2 then 'Removed the number' end
from generate_series(1, 6) g;

insert into public.password_reset_tokens (user_id, token, expires_at)
select u.id, md5('reset' || u.n), timestamptz '2026-11-19 00:00:00+00' from {u} u where u.n in (3, 6, 9);
insert into public.email_verification_tokens (user_id, token, expires_at)
select u.id, md5('verify' || u.n), timestamptz '2026-11-19 00:00:00+00' from {u} u where u.n in (4, 8, 12);
"""


_N = PRODUCTION_ACCOUNTS
PRODUCTION_SEEDED_COUNTS = {
    "users": _N, "profiles": _N, "notes": 4 * _N + 1, "flashcards": 3 * _N, "summaries": 2 * _N,
    "study_sessions": 2 * _N, "transcripts": _N, "notifications": 2 * _N, "ai_usage": 3 * _N,
    "analytics_events": 5 * _N + 3, "billing_accounts": 4, "billing_subscriptions": 4, "subscriptions": 3,
    "email_codes": 2 * (_N // 4) + 3, "ai_allowance_usage": 4 * _N, "content_reports": 6,
    "password_reset_tokens": 3, "email_verification_tokens": 3,
}


def build(tools: PgTools, base_dir: Path, port: int, migrations: list[Path] | None = None,
          install_guard: bool = True, seed: str | None = None) -> LocalCluster:
    """initdb + start a source cluster and fill database 'postgres' with fake Luma data
    (`seed`, default the small seed_sql())."""
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
    tools.psql(conn, seed_sql() if seed is None else seed)
    if install_guard:
        tools.psql(conn, GUARD_FILE.read_text(encoding="utf-8"))
    return cluster



def build_production(tools: PgTools, base_dir: Path, port: int) -> LocalCluster:
    """A database shaped like production today (live shape + migrations up to LIVE_MIGRATIONS_UPTO
    + the password guard), filled by production_seed_sql()."""
    return build(tools, base_dir, port, migrations=migration_files(upto=LIVE_MIGRATIONS_UPTO),
                 seed=production_seed_sql())

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
