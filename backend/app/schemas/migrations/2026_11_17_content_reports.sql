-- 2026-11-17: reports about public study content (review queue). NOT APPLIED.
-- Run only with the owner's OK. Additive: one new table, no existing rows change.
--
-- reporter_id is set to NULL when the reporting account is deleted (the
-- report stays for safety review, without the name). Admin review happens in
-- Luma (/admin/reports); nothing is emailed or sent outside Luma.
-- RLS on with no policies; only the backend (service role) uses the table.

begin;

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in ('note', 'flashcards', 'summary')),
  item_id text not null,
  item_title text,
  reason text not null check (reason in ('bullying', 'unsafe', 'private_info', 'spam', 'copyright', 'wrong_info', 'other')),
  details text check (details is null or char_length(details) <= 500),
  reporter_id uuid references public.users (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_note text check (reviewer_note is null or char_length(reviewer_note) <= 500)
);

create index if not exists content_reports_status_created_idx
  on public.content_reports (status, created_at desc);
create index if not exists content_reports_reporter_item_idx
  on public.content_reports (reporter_id, item_type, item_id);

alter table public.content_reports enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.content_reports from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.content_reports from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.content_reports to service_role';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
