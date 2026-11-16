-- 2026-11-16: email codes + email-keyed free AI allowance. NOT APPLIED. Run only with the owner's OK.
--
-- Additive only: two new tables and one unique index on users. No rows change.
-- Safe to run more than once (IF NOT EXISTS everywhere).
--
-- email_codes
--   6-digit email codes. Only an HMAC digest is stored (keyed with the server
--   secret), never the code. One row per code sent. A code is usable while
--   consumed_at and superseded_at are both NULL and expires_at is in the future.
--   Pending signups live here too (no users row until the code is entered).
--   The backend uses conditional (compare-and-swap) updates on attempts and
--   consumed_at, so the row needs no locking functions.
--   Rows for an account go away with it (ON DELETE CASCADE). Old pending rows
--   hold a password hash: delete rows older than a few days (cleanup not automated yet).
--
-- users_email_lower_key
--   Unique index on lower(email): a second account with the same email (any
--   letter case) is refused by the database, even if two signups race.
--
-- ai_allowance_usage
--   Free AI uses per day under a keyed hash of the normalized email. It is NOT
--   linked to users on purpose: deleting and re-creating an account with the
--   same email must not reset the count. It holds no email, only the hash.
--   Retention: rows older than a few days are not needed and can be deleted by
--   a periodic cleanup (not automated yet).
--
-- Both tables: row level security ON with no policies, and no privileges for
-- anon/authenticated. Only the backend (service role / secret key) uses them.

begin;

create table if not exists public.email_codes (
  id uuid primary key default gen_random_uuid(),
  -- NULL for a pending signup (no account exists until the code is entered).
  user_id uuid references public.users (id) on delete cascade,
  purpose text not null check (purpose in ('verify_email', 'signup')),
  -- The lowercase address the code was sent to. The code only works for it.
  email text not null,
  code_digest text not null,
  -- Pending signups only: digest of the browser's random ticket, the chosen
  -- username and the argon2id hash of the chosen password.
  ticket_digest text,
  pending_username text,
  pending_password_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  superseded_at timestamptz,
  check (
    (purpose = 'verify_email' and user_id is not null)
    or (purpose = 'signup' and user_id is null and ticket_digest is not null and pending_password_hash is not null)
  )
);

create index if not exists email_codes_user_purpose_created_idx
  on public.email_codes (user_id, purpose, created_at desc);
create index if not exists email_codes_email_created_idx
  on public.email_codes (email, created_at desc);

-- One account per email, whatever the letter case. The live table had 10 rows,
-- 10 distinct lowercase emails and no mixed-case emails on 2026-11-16 (checked
-- read-only), so this index can be created. If it fails, duplicates appeared:
-- stop and ask before merging any accounts.
create unique index if not exists users_email_lower_key on public.users (lower(email));

create table if not exists public.ai_allowance_usage (
  email_key text not null,
  day date not null,
  usage_type text not null check (usage_type in ('notes', 'transcription')),
  used integer not null default 0 check (used >= 0),
  primary key (email_key, day, usage_type)
);

alter table public.email_codes enable row level security;
alter table public.ai_allowance_usage enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.email_codes, public.ai_allowance_usage from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.email_codes, public.ai_allowance_usage from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.email_codes, public.ai_allowance_usage to service_role';
  end if;
end
$$;

commit;
