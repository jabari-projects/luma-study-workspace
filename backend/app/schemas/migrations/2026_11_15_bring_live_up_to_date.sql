-- =============================================================================
-- Migration 2026-11-15: bring the live Luma database up to what the code needs
-- =============================================================================
--
-- WHAT IT CHANGES
--   Adds the columns, defaults, tables, indexes, search triggers and storage
--   bucket that the current backend reads or writes but the live database is
--   missing (compared against the live API description captured 2026-11-15):
--     users           + password_reset_token, password_reset_sent_at
--     profiles        + subscription_status ('free'; 'premium' for accounts
--                       with a still-billable legacy public.subscriptions row)
--     notes           + is_public, published_at, published_by, study_type
--     flashcards      + title, cards (one-card backfill from front/back),
--                       is_public, published_at, published_by, study_type
--     summaries       + title, tags, updated_at, is_public, published_at,
--                       published_by, study_type
--     study_sessions  + updated_at, search_vector
--     transcripts     + updated_at
--     ai_usage        feature gets a default ('ai') so the code's insert of
--                     (user_id, type, created_at) stops failing
--     notifications   + type ('system'), actor_user_id, payload; message gets
--                     a default ('') so the code's insert stops failing; old
--                     rows get payload = {"message": <their message>}
--     new tables      analytics_events, billing_accounts, billing_subscriptions
--     search          search_vector trigger functions/triggers replaced so they
--                     read title + content + tags consistently
--     storage         "themes" bucket (public, like "avatars")
--
-- ADDITIVE ONLY
--   Nothing is dropped, renamed, retyped or deleted. No existing value is
--   changed. The only UPDATEs fill NEW columns on existing rows:
--     * profiles.subscription_status (only in the run that adds it; 'premium'
--       where the account's own legacy subscriptions row is still billable)
--     * flashcards.cards  (from that row's own front/back, only where empty)
--     * notifications.payload (from that row's own message, only where null)
--   Safe to run more than once: every step is "if not exists" / "or replace" /
--   guarded, and a second run changes nothing.
--
-- HOW LONG
--   Seconds for tables of a few thousand rows. New columns with constant
--   defaults are metadata-only on Postgres 11+ (no table rewrite). The cost is
--   the two backfills (one row version per flashcard / notification) and the
--   index builds, which block writes to that table while they run (fast on
--   small tables). lock_timeout below makes the run fail and roll back instead
--   of queueing behind a long-running query.
--   LOCKS: the first statement takes an exclusive lock on users, and by the end
--   all 12 affected tables (users, profiles, notes, flashcards, summaries,
--   study_sessions, transcripts, notifications, ai_usage and the 3 new tables)
--   are exclusively locked until commit. The app is effectively paused
--   (logins included, reads too) for the duration; expect seconds on small
--   tables. Apply in a low-traffic window. If the size check below shows a
--   large flashcards or notifications table (hundreds of thousands of rows),
--   stop and split the index builds out of the transaction first.
--
-- BEFORE APPLYING (backup)
--   1. Supabase Dashboard -> Database -> Backups: confirm a recent backup exists
--      (or take one: on Pro, "Point in time"; otherwise
--      `pg_dump --schema=public --schema=storage` with the service connection
--      string, stored somewhere safe and never committed).
--   2. Run the commented VERIFY block at the bottom once and keep the counts
--      (it includes the flashcards / notifications sizes for the lock note).
--   3. List the live triggers on the tables this touches (read-only, block
--      PRE-CHECK at the bottom). The flashcards and notifications backfills
--      fire every trigger on those tables. If an "updated_at" touch trigger
--      exists there, updated_at changes on the backfilled rows; accept that
--      or stop. search_vector on backfilled flashcards is recomputed by the new
--      function; it is unchanged only if the live trigger already indexed
--      front/back/tags (the code never reads search_vector either way).
--   4. Confirm SUPABASE_SERVICE_ROLE_KEY is set for the production backend.
--      The new tables have row level security with no policies, so with only
--      the anon key analytics inserts are silently dropped (billing and
--      account deletion need the service key anyway).
--
-- OWNER DECISIONS THIS FILE DOES NOT MAKE
--   * Account deletion and legacy rows: public.subscriptions,
--     email_verification_tokens and password_reset_tokens reference users(id)
--     with an unknown (assumed NO ACTION) delete rule. Deleting such an
--     account fails at the users row AFTER its study data and profile are
--     gone (true today as well). Accounts with a still-billable legacy
--     subscription now stop earlier, at billing_needs_review (section 2), but
--     an account with only a legacy token row, or a canceled legacy
--     subscription, still half-deletes. Do not enable or advertise account
--     deletion until that is fixed in a separate reviewed change (clean up
--     those tables in account deletion, or change their delete rule).
--     Legacy subscriptions still need linking by hand: see the VERIFY query
--     legacy_live_subs_needing_manual_link.
--   * analytics_events.user_id references profiles(user_id), as in
--     analytics_events_schema.sql: an event for a user with no profile row
--     fails its foreign key and analytics.py drops that batch.
--
-- HOW TO APPLY
--   Supabase Dashboard -> SQL Editor -> paste this whole file -> Run, as ONE
--   run. It is one transaction (begin ... commit): if any statement fails,
--   nothing is applied. Then run the VERIFY block again and compare.
--   Requires Postgres 14+ (create or replace trigger); checked below.
--
-- NOT IN THIS FILE (on purpose)
--   * Password hash guard: install backend/app/schemas/password_hash_guard.sql
--     only AFTER the hashing login code is deployed on every instance, and
--     BEFORE running backend/scripts/hash_existing_passwords.py --apply. That
--     order is the password rollout runbook; it must not ride along here.
--   * Billing backfill from the legacy public.subscriptions table: see the
--     note in section 9. Owners are never guessed.
--   * Row level security on EXISTING tables: the live policies are unknown, so
--     they are left exactly as they are (owner check).
--   * search_vector backfill of existing rows: optional, see section 10.
-- =============================================================================

begin;

-- Fail fast instead of waiting behind other sessions' locks.
set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- -----------------------------------------------------------------------------
-- 0. Preconditions: stop (and roll back) if this is not the expected database.
-- -----------------------------------------------------------------------------
do $$
declare
  required text[] := array['users', 'profiles', 'notes', 'flashcards', 'summaries',
                           'study_sessions', 'transcripts', 'notifications', 'ai_usage'];
  t text;
begin
  if current_setting('server_version_num')::int < 140000 then
    raise exception 'Postgres 14 or newer is required (found %)', current_setting('server_version');
  end if;
  foreach t in array required loop
    if to_regclass('public.' || t) is null then
      raise exception 'Expected table public.% is missing; is this the right database?', t;
    end if;
  end loop;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'user_id'
  ) then
    raise exception 'public.profiles.user_id is missing; this migration expects the live shape.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. users: password reset columns (main.py issue/consume password reset).
--    Index matches password_reset_schema.sql (column is new, so it is empty).
-- -----------------------------------------------------------------------------
alter table public.users
  add column if not exists password_reset_token text,
  add column if not exists password_reset_sent_at timestamptz;

create unique index if not exists users_password_reset_token_idx
  on public.users (password_reset_token)
  where password_reset_token is not null;

-- -----------------------------------------------------------------------------
-- 2. profiles: subscription_status (billing.py, main.py, account_deletion.py).
--    Existing rows read 'free', which is what the code already assumes today
--    when the column is missing (profile.get("subscription_status") or "free"),
--    EXCEPT accounts that own a still-billable row in the legacy
--    public.subscriptions table: those read 'premium'.
--
--    Why: the code never reads public.subscriptions. With 'free', a paying
--    legacy subscriber would lose Premium, could start a second checkout, and
--    account deletion would not stop at billing_needs_review, so the legacy
--    Stripe subscription would keep billing after the account was gone.
--    'premium' with no billing link makes billing.is_unlinked_paid_account()
--    and the account-deletion billing gate apply until support links or
--    cancels it by hand. Ownership is the row's own user_id column (NOT NULL,
--    foreign key to users.id), not a guess; nothing is copied into the billing
--    tables. The status list is the one account deletion treats as still
--    billable (ACTIVE_SUBSCRIPTION_STATUSES), so past_due/unpaid/incomplete/
--    paused also read 'premium' here: safer to over-protect than to let an
--    unseen subscription keep charging.
--
--    Runs only in the run that ADDS the column, so a later run never
--    overwrites a status the app has since set (for example after support
--    linked the subscription and the webhook refreshed it).
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'subscription_status'
  ) then
    alter table public.profiles
      add column subscription_status text not null default 'free';

    if to_regclass('public.subscriptions') is not null then
      update public.profiles p
      set subscription_status = 'premium'
      where exists (
        select 1 from public.subscriptions s
        where s.user_id = p.user_id
          and lower(coalesce(s.status, '')) in
              ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused')
      );
    end if;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3. notes: publish fields (notes.py, publishing.py, public_search.py).
-- -----------------------------------------------------------------------------
alter table public.notes
  add column if not exists is_public boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists study_type text not null default 'note';

-- -----------------------------------------------------------------------------
-- 4. flashcards: deck title, cards and publish fields (flashcards.py).
-- -----------------------------------------------------------------------------
alter table public.flashcards
  add column if not exists title text,
  add column if not exists cards jsonb not null default '[]'::jsonb,
  add column if not exists is_public boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists study_type text not null default 'flashcards';

-- -----------------------------------------------------------------------------
-- 5. summaries: title, tags, updated_at and publish fields (summaries.py).
--    source_type / source_id stay as they are (the code does not use them).
--    tags is NOT NULL as in summaries_schema/notes: an explicit "tags": null in
--    an update is rejected (same as notes.tags today; the frontend never sends
--    it). Normalising None to [] belongs in the update handlers, not here.
-- -----------------------------------------------------------------------------
alter table public.summaries
  add column if not exists title text,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists updated_at timestamptz default now(),
  add column if not exists is_public boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists study_type text not null default 'summary';

-- -----------------------------------------------------------------------------
-- 6. study_sessions and transcripts: updated_at (both routers write it).
--    study_sessions.search_vector is added so the search trigger in section 10
--    has somewhere to write (the code never reads it).
-- -----------------------------------------------------------------------------
alter table public.study_sessions
  add column if not exists updated_at timestamptz default now(),
  add column if not exists search_vector tsvector;

alter table public.transcripts
  add column if not exists updated_at timestamptz default now();

-- -----------------------------------------------------------------------------
-- 7. ai_usage: the code inserts (user_id, type, created_at) only. Live has
--    feature text NOT NULL with no default, so every insert fails today.
--    A default fixes that; existing rows and their feature values are kept.
-- -----------------------------------------------------------------------------
alter table public.ai_usage
  alter column feature set default 'ai';

create index if not exists ai_usage_user_id_created_at_idx
  on public.ai_usage (user_id, created_at desc);
create index if not exists ai_usage_user_id_type_idx
  on public.ai_usage (user_id, type);

-- -----------------------------------------------------------------------------
-- 8. notifications: the code inserts (id, user_id, type, actor_user_id,
--    created_at, read, payload) and never sends message; it lists by
--    type = 'system' and account deletion nulls actor_user_id.
-- -----------------------------------------------------------------------------
alter table public.notifications
  add column if not exists type text not null default 'system',
  add column if not exists actor_user_id uuid references public.users (id) on delete set null,
  add column if not exists payload jsonb;

alter table public.notifications
  alter column message set default '';

-- type allows only 'system' (notifications_schema.sql and the code's
-- Literal['system']). Widen this constraint in the same change that adds a new
-- notification type.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and conname = 'notifications_type_check'
  ) then
    alter table public.notifications
      add constraint notifications_type_check check (type in ('system'));
  end if;
end $$;

-- Old rows keep their message column untouched; payload (new, null) gets a
-- copy so the app shows the real text instead of "You have a new notification"
-- (main.py build_human_readable_notification reads payload.message).
update public.notifications
set payload = jsonb_build_object('message', message)
where payload is null
  and message is not null
  and message <> '';

create index if not exists notifications_user_id_idx
  on public.notifications (user_id);
create index if not exists notifications_user_created_at_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_actor_user_id_idx
  on public.notifications (actor_user_id);
create index if not exists notifications_user_read_idx
  on public.notifications (user_id, read);

-- -----------------------------------------------------------------------------
-- 9. New tables.
-- -----------------------------------------------------------------------------

-- 9a. analytics_events (analytics.py). Same columns as
-- analytics_events_schema.sql. Differences, both deliberate:
--   * id default gen_random_uuid() (built in) instead of uuid_generate_v4(),
--     which on Supabase lives in the "extensions" schema and may not be on the
--     SQL editor's search_path. Same type, same behaviour.
--   * row level security enabled with no policies, like the billing tables:
--     this table holds per-user page paths, and without RLS anyone with the
--     public anon key could read or write it through the REST API. The backend
--     uses the service-role key, which bypasses RLS.
create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(user_id) on delete set null,
  event_name text not null,
  event_group text not null,
  page_path text,
  feature_key text,
  subscription_tier text,
  surface text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_user_created_at_idx
  on public.analytics_events (user_id, created_at desc);
create index if not exists analytics_events_event_name_idx
  on public.analytics_events (event_name, created_at desc);
create index if not exists analytics_events_event_group_idx
  on public.analytics_events (event_group, created_at desc);

alter table public.analytics_events enable row level security;

-- 9b. billing_accounts / billing_subscriptions: copied from billing_schema.sql.
--
-- LEGACY SUBSCRIPTIONS ARE NOT BACKFILLED. The legacy public.subscriptions
-- table holds Stripe customer/subscription ids from before these link tables
-- existed. They are NOT copied here: ownership must come from Stripe itself
-- (Checkout Session client_reference_id / metadata.user_id), never be inferred.
-- Support can use those legacy ids to look each subscription up in the Stripe
-- dashboard, confirm the owner, and then insert the link rows by hand after
-- review. public.subscriptions is left untouched.
create table if not exists public.billing_accounts (
  user_id uuid primary key references public.users(id) on delete cascade,
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  stripe_customer_id text not null,
  status text not null,
  current_period_end timestamptz null,
  updated_at timestamptz not null default now()
);

create index if not exists billing_subscriptions_user_id_idx
  on public.billing_subscriptions (user_id);

-- Only the backend (service role) reads or writes billing links.
alter table public.billing_accounts enable row level security;
alter table public.billing_subscriptions enable row level security;

-- -----------------------------------------------------------------------------
-- 10. Search triggers (personal_search_schema.sql).
--
-- Live has search_vector on notes, flashcards, summaries and transcripts, so
-- triggers from an earlier version of personal_search_schema.sql may exist.
-- That earlier version indexed summaries by content only and flashcards by
-- front/back/tags. The functions below are the current versions; they read
-- only columns that exist once sections 3-6 have run (title, content, tags,
-- front, back, name, subject, notes).
--
-- Why this is safe for existing rows:
--   * A trigger function only runs on future INSERT/UPDATE of a row; replacing
--     it changes no stored data by itself.
--   * Each function only assigns NEW.search_vector, a derived column the code
--     never reads. No other column is touched.
--   * For existing rows the new title is NULL and tags is '{}', so the vector
--     the new function would compute has exactly the same lexemes as the one
--     the old function stored. Nothing becomes stale.
--   * "create or replace trigger" keeps the same trigger names, so a live
--     trigger of that name is replaced in place, not duplicated.
-- -----------------------------------------------------------------------------
create or replace function public.notes_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'english',
      coalesce(new.title, '') || ' ' ||
      coalesce(new.content, '') || ' ' ||
      coalesce(array_to_string(new.tags, ' '), '')
    );
  return new;
end;
$$;

create or replace function public.flashcards_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'english',
      coalesce(new.title, '') || ' ' ||
      coalesce(new.front, '') || ' ' ||
      coalesce(new.back, '') || ' ' ||
      coalesce(array_to_string(new.tags, ' '), '')
    );
  return new;
end;
$$;

create or replace function public.study_sessions_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'english',
      coalesce(new.name, '') || ' ' ||
      coalesce(new.subject, '') || ' ' ||
      coalesce(new.notes, '')
    );
  return new;
end;
$$;

create or replace function public.summaries_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'english',
      coalesce(new.title, '') || ' ' ||
      coalesce(new.content, '') || ' ' ||
      coalesce(array_to_string(new.tags, ' '), '')
    );
  return new;
end;
$$;

create or replace function public.transcripts_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.content, ''));
  return new;
end;
$$;

create or replace trigger notes_search_update
before insert or update on public.notes
for each row execute function public.notes_search_vector_trigger();

create or replace trigger flashcards_search_update
before insert or update on public.flashcards
for each row execute function public.flashcards_search_vector_trigger();

create or replace trigger study_sessions_search_update
before insert or update on public.study_sessions
for each row execute function public.study_sessions_search_vector_trigger();

create or replace trigger summaries_search_update
before insert or update on public.summaries
for each row execute function public.summaries_search_vector_trigger();

create or replace trigger transcripts_search_update
before insert or update on public.transcripts
for each row execute function public.transcripts_search_vector_trigger();

-- Optional, NOT run here: fill search_vector for rows that have none (for
-- example rows written before any trigger existed, and study_sessions rows).
-- The backend never reads search_vector, so this can wait. Each statement
-- writes one new row version per matching row and holds row locks until the
-- transaction ends: fine for small tables, batch it for large ones.
--   update public.study_sessions set name = name where search_vector is null;
--   update public.notes          set title = title where search_vector is null;
--   update public.flashcards     set front = front where search_vector is null;
--   update public.summaries      set content = content where search_vector is null;
--   update public.transcripts    set content = content where search_vector is null;

-- -----------------------------------------------------------------------------
-- 11. flashcards one-card backfill (same rule as flashcards_schema.sql).
--     Runs after section 10 so the BEFORE UPDATE trigger recomputes each
--     touched row's search_vector with the new function (identical lexemes,
--     because title is still NULL). Only rows whose cards are still empty.
-- -----------------------------------------------------------------------------
update public.flashcards
set cards = jsonb_build_array(
  jsonb_build_object('id', id::text || '-0', 'front', front, 'back', back, 'review', null)
)
where (cards is null or cards = '[]'::jsonb)
  and front is not null
  and back is not null;

-- -----------------------------------------------------------------------------
-- 12. Indexes the schema files define for the code's read patterns.
--     "if not exists" skips any that the live database already has.
-- -----------------------------------------------------------------------------
create index if not exists notes_user_id_created_at_idx
  on public.notes (user_id, created_at desc);
create index if not exists notes_is_public_created_at_idx
  on public.notes (is_public, created_at desc);
create index if not exists notes_published_at_idx
  on public.notes (published_at desc);
create index if not exists notes_updated_at_idx
  on public.notes (updated_at desc);

create index if not exists flashcards_user_id_created_at_idx
  on public.flashcards (user_id, created_at desc);
create index if not exists flashcards_is_public_created_at_idx
  on public.flashcards (is_public, created_at desc);
create index if not exists flashcards_published_at_idx
  on public.flashcards (published_at desc);
create index if not exists flashcards_updated_at_idx
  on public.flashcards (updated_at desc);

create index if not exists summaries_user_id_created_at_idx
  on public.summaries (user_id, created_at desc);
create index if not exists summaries_is_public_created_at_idx
  on public.summaries (is_public, created_at desc);
create index if not exists summaries_published_at_idx
  on public.summaries (published_at desc);
create index if not exists summaries_updated_at_idx
  on public.summaries (updated_at desc);

create index if not exists study_sessions_user_id_created_at_idx
  on public.study_sessions (user_id, created_at desc);
create index if not exists study_sessions_updated_at_idx
  on public.study_sessions (updated_at desc);

create index if not exists transcripts_user_id_created_at_idx
  on public.transcripts (user_id, created_at desc);
create index if not exists transcripts_updated_at_idx
  on public.transcripts (updated_at desc);

-- =============================================================================
-- 13. STORAGE (separate section): the "themes" bucket.
--
-- main.py uploads theme images to bucket "themes" at themes/<user_id>/<file>
-- and stores supabase.storage.from_("themes").get_public_url(path). A public
-- URL (/storage/v1/object/public/themes/...) only serves files from a PUBLIC
-- bucket, and main.py / account_deletion.py parse exactly that URL shape, so
-- the bucket must be public, the same way "avatars" is used. Uploads and
-- deletes go through the backend's service-role key, so no storage policies
-- are added here. Live has only "avatars"; this adds "themes" and changes
-- nothing if it already exists.
-- =============================================================================
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise exception 'storage.buckets is missing; is this a Supabase database?';
  end if;
  insert into storage.buckets (id, name, public)
  values ('themes', 'themes', true)
  on conflict (id) do nothing;
end $$;

-- Ask the Supabase REST layer to pick up the new columns right away.
notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- PRE-CHECK (read-only; trigger definitions only, no row data). Run before.
-- =============================================================================
-- select tgrelid::regclass as table_name, tgname, pg_get_triggerdef(oid) as definition
-- from pg_trigger
-- where not tgisinternal
--   and tgrelid in ('public.flashcards'::regclass, 'public.notifications'::regclass,
--                   'public.notes'::regclass, 'public.summaries'::regclass,
--                   'public.transcripts'::regclass, 'public.study_sessions'::regclass,
--                   'public.profiles'::regclass)
-- order by 1, 2;

-- =============================================================================
-- VERIFY (read-only; counts only, no row data). Run before and after.
-- =============================================================================
-- select
--   (select count(*) from public.users)                                   as users,
--   (select count(*) from public.profiles)                                as profiles,
--   (select count(*) from public.notes)                                   as notes,
--   (select count(*) from public.flashcards)                              as flashcards,
--   (select count(*) from public.summaries)                               as summaries,
--   (select count(*) from public.study_sessions)                          as study_sessions,
--   (select count(*) from public.transcripts)                             as transcripts,
--   (select count(*) from public.notifications)                           as notifications,
--   (select count(*) from public.ai_usage)                                as ai_usage,
--   (select count(*) from public.subscriptions)                           as legacy_subscriptions,
--   (select count(*) from public.subscriptions
--     where lower(coalesce(status, '')) in
--           ('active','trialing','past_due','unpaid','incomplete','paused'))  as legacy_billable_subscriptions;
--
-- After applying (each should be as noted):
-- select
--   (select count(*) from information_schema.columns
--     where table_schema = 'public'
--       and (table_name, column_name) in (
--         ('users','password_reset_token'), ('users','password_reset_sent_at'),
--         ('profiles','subscription_status'),
--         ('notes','is_public'), ('notes','published_at'), ('notes','published_by'), ('notes','study_type'),
--         ('flashcards','title'), ('flashcards','cards'), ('flashcards','is_public'),
--         ('flashcards','published_at'), ('flashcards','published_by'), ('flashcards','study_type'),
--         ('summaries','title'), ('summaries','tags'), ('summaries','updated_at'), ('summaries','is_public'),
--         ('summaries','published_at'), ('summaries','published_by'), ('summaries','study_type'),
--         ('study_sessions','updated_at'), ('transcripts','updated_at'),
--         ('notifications','type'), ('notifications','actor_user_id'), ('notifications','payload')))
--                                                                          as new_columns_expect_25,
--   (select count(*) from information_schema.tables where table_schema = 'public'
--     and table_name in ('analytics_events','billing_accounts','billing_subscriptions'))
--                                                                          as new_tables_expect_3,
--   (select count(*) from public.flashcards where cards = '[]'::jsonb)    as flashcards_without_cards_expect_0,
--   (select count(*) from storage.buckets where id = 'themes' and public)  as themes_bucket_expect_1,
--   (select count(*) from public.profiles p where p.subscription_status = 'premium'
--     and exists (select 1 from public.subscriptions s where s.user_id = p.user_id
--       and lower(coalesce(s.status, '')) in
--           ('active','trialing','past_due','unpaid','incomplete','paused')))
--                                                                          as premium_from_legacy_subs,
--   (select count(*) from pg_trigger where not tgisinternal
--     and tgname like '%\_search\_update')                                 as search_triggers_expect_5,
--   (select count(*) from public.subscriptions s
--     where s.status in ('active','trialing','past_due','unpaid','incomplete','paused')
--       and not exists (select 1 from public.billing_subscriptions b
--                       where b.stripe_subscription_id = s.stripe_subscription_id))
--                                                                          as legacy_live_subs_needing_manual_link;
