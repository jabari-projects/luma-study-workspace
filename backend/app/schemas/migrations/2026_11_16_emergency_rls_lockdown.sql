-- EMERGENCY LOCKDOWN (2026-11-16) -- NOT APPLIED. Run only with the owner's approval.
--
-- Why: on 2026-11-16 a count-only check showed that the PUBLIC anon key (it ships in
-- every browser and has been in public GitHub history since 2026-04) can read the live
-- users, profiles, notes and study_sessions tables, including the plaintext `password`
-- column. Row level security (RLS) is off on those tables.
--
-- What this does:
--   1. Turns on RLS for EVERY table in the public schema, with no policies. The anon and
--      authenticated roles then see nothing. service_role (the backend) bypasses RLS, so
--      the backend keeps working IF Render uses SUPABASE_SERVICE_ROLE_KEY (or a new
--      sb_secret key), not the anon key.
--   2. Removes table and sequence privileges from anon and authenticated (belt and braces),
--      including for tables created later by the postgres role.
--
-- What it does NOT do: it doesn't drop, change or read any rows, and it doesn't touch the
-- plaintext passwords (that is the separate password rollout in the vault runbook).
--
-- Luma's frontend never queries Supabase tables directly (no createClient in frontend/src),
-- so browsers lose nothing. Storage buckets live in the storage schema and aren't touched.
--
-- Check afterwards (count only, with the anon key): HEAD /rest/v1/users?select=id -> 401/403
-- or an empty count, and the backend's login for a made-up email still answers 401 (not 500).
-- Undo if the backend breaks: ALTER TABLE ... DISABLE ROW LEVEL SECURITY for the affected
-- table, then fix Render to use the service-role/secret key and run this again.

begin;

-- The live users table has RLS on, but two policies let ANYONE read and insert rows
-- (found 2026-11-16: allow_select USING true, allow_insert WITH CHECK true, role public).
-- The backend (service_role) doesn't need them, so remove them.
drop policy if exists allow_select on public.users;
drop policy if exists allow_insert on public.users;

do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'alter default privileges for role postgres in schema public revoke all on tables from anon';
    execute 'alter default privileges for role postgres in schema public revoke all on sequences from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
    execute 'alter default privileges for role postgres in schema public revoke all on tables from authenticated';
    execute 'alter default privileges for role postgres in schema public revoke all on sequences from authenticated';
  end if;
end
$$;

commit;
