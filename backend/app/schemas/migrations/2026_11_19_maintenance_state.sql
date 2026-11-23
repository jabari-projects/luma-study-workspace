-- 2026-11-19: maintenance mode (one shared break state for every server instance). NOT APPLIED.
-- Run only with the owner's OK. Additive: four new tables, no existing rows change.
-- Safe to run twice (if not exists / on conflict do nothing).
--
-- maintenance_state      one row (id = 1): the phase every server instance follows.
--                        Changed only by the admin routes, with a compare-and-swap on rev.
-- maintenance_instances  one row per running server: requests in flight, last heartbeat.
-- maintenance_jobs       one row per AI or other long request while it runs.
-- maintenance_log        who changed the phase and when. detail holds codes and counts only,
--                        never student content.
-- RLS on with no policies; only the backend (service role) uses these tables.
-- Checked by backend/scripts/check_maintenance_migration.mjs (PGlite) and
-- backend/tests/test_maintenance_migration_file.py.

begin;

-- Fail fast instead of queueing every student's save behind a lock: if another session holds
-- one of these tables, or a step runs long, the whole file rolls back with nothing changed.
-- It is safe to run again (docs/deployment-checklist.md).
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create table if not exists public.maintenance_state (
  id smallint primary key default 1 check (id = 1),
  phase text not null default 'none' check (phase in ('none', 'announced', 'draining', 'active', 'checking')),
  rev bigint not null default 1,
  reason text not null default '' check (reason in ('', 'database_update', 'website_update', 'backup_check', 'other')),
  note text not null default '' check (char_length(note) <= 200),
  start_at timestamptz,
  estimated_end_at timestamptz,
  drain_started_at timestamptz,
  grace_ends_at timestamptz,
  activated_at timestamptz,
  backup_ref text check (backup_ref is null or backup_ref ~ '^[0-9]{8}T[0-9]{6}Z$'),
  counts_at_activation jsonb,
  checks jsonb,
  checks_passed_at timestamptz,
  reopened_at timestamptz,
  updated_by uuid references public.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.maintenance_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.maintenance_instances (
  instance_id text primary key,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  in_flight integer not null default 0,
  phase_seen text not null default 'none',
  code_version text not null default ''
);

create table if not exists public.maintenance_jobs (
  job_id uuid primary key,
  instance_id text not null,
  kind text not null check (kind in ('ai_notes', 'ai_image', 'ai_transcribe', 'ai_summary', 'link_import', 'account_deletion', 'upload')),
  started_at timestamptz not null default now(),
  expected_end_at timestamptz not null
);

create table if not exists public.maintenance_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_user_id uuid references public.users (id) on delete set null,
  action text not null,
  from_phase text,
  to_phase text,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists maintenance_log_at_idx on public.maintenance_log (at desc);

alter table public.maintenance_state enable row level security;
alter table public.maintenance_instances enable row level security;
alter table public.maintenance_jobs enable row level security;
alter table public.maintenance_log enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['maintenance_state', 'maintenance_instances', 'maintenance_jobs', 'maintenance_log'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table public.%I from authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on table public.%I to service_role', t);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';

commit;

-- VERIFY (run after applying; read-only):
-- select id, phase, rev from public.maintenance_state;                       -- one row: 1, none, 1
-- select relname, relrowsecurity from pg_class
--   where relname in ('maintenance_state', 'maintenance_instances', 'maintenance_jobs', 'maintenance_log');  -- all true
