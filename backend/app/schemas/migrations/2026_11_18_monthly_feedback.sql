-- Monthly student feedback poll ("If it ain't broke why fix it?!"), 2026-11-18.
-- NOT APPLIED. Run only with the owner's OK, after checking backups and point-in-time recovery.
-- Needs Postgres 14+ (create or replace trigger). Proven on PGlite by
-- backend/scripts/check_feedback_migration.mjs.
-- Additive: new feedback_* tables, functions and triggers only. Changes no existing table or row.
--
-- One ballot per account per poll, enforced here (unique keys), plus one per EMAIL per poll:
-- voter_key is a keyed one-way hash of the normalized email (made by the backend with
-- FEEDBACK_VOTER_KEY_SECRET, or the JWT secret when that isn't set), so deleting an account
-- and signing up again with the same email can't vote twice in the same poll. The key is only
-- needed while the poll is open: once the poll has closed, an anonymous ballot's voter_key is
-- cleared (feedback_forget_voter_keys), so nobody holding the secret can match a known email
-- to a deleted account's answers.
--
-- Ballots are written ONLY by feedback_submit (security definer). The service role can't
-- insert ballots or answers directly, so "ballots never change" and "verified email only"
-- hold in the database itself, not only in backend code.
--
-- Account deletion (owner decision 2026-11-17): the person's poll ANSWERS stay in the totals
-- without their name (feedback_responses.user_id becomes null), and their poll COMMENTS are
-- deleted (comment and urgent flags cleared, theme links removed). The backend does this as a
-- deletion step; the "on delete set null" foreign key plus the guard trigger below do the same
-- thing if a users row is ever removed some other way. Skip records are deleted.
--
-- Wording locks once voting starts: questions can change only while a poll is a draft, dates
-- only before it opens, and ballots never change (only the anonymizing clear above).
-- RLS on with no policies; only the backend (service role) uses these tables.

begin;

create table if not exists public.feedback_polls (
  id uuid primary key default gen_random_uuid(),
  period_month date not null check (extract(day from period_month) = 1),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  approved_at timestamptz,                         -- null = draft (never opens by itself)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feedback_polls_period_month_key unique (period_month),
  constraint feedback_polls_window check (closes_at > opens_at and closes_at - opens_at <= interval '31 days'),
  constraint feedback_polls_no_overlap exclude using gist
    (tstzrange(opens_at, closes_at, '[)') with &&) where (approved_at is not null)
);
create index if not exists feedback_polls_closes_idx
  on public.feedback_polls (closes_at desc) where approved_at is not null;

create table if not exists public.feedback_questions (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.feedback_polls (id) on delete cascade,
  position smallint not null check (position between 1 and 12),
  label text not null check (char_length(btrim(label)) between 3 and 160),
  constraint feedback_questions_position_key unique (poll_id, position),
  constraint feedback_questions_poll_id_id_key unique (poll_id, id)
);

create table if not exists public.feedback_responses (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.feedback_polls (id) on delete restrict,
  user_id uuid references public.users (id) on delete set null,   -- null once the account is deleted
  voter_key text check (voter_key is null or voter_key ~ '^[0-9a-f]{64}$'),  -- null once forgotten (see above)
  comment text check (comment is null or (char_length(comment) between 1 and 500
                     and comment !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  urgent_flags text[] not null default '{}'
    check (urgent_flags <@ array['security', 'accessibility', 'privacy']::text[]),
  urgent_set_by_admin boolean not null default false,
  submitted_at timestamptz not null default now(),
  constraint feedback_responses_one_per_account unique (poll_id, user_id),
  constraint feedback_responses_one_per_email unique (poll_id, voter_key),
  constraint feedback_responses_poll_id_id_key unique (poll_id, id)
);
create index if not exists feedback_responses_user_idx on public.feedback_responses (user_id);
create index if not exists feedback_responses_forget_idx
  on public.feedback_responses (poll_id) where user_id is null and voter_key is not null;

create table if not exists public.feedback_answers (
  response_id uuid not null,
  poll_id uuid not null,
  question_id uuid not null,
  wants_change boolean not null,                   -- true = "Yes, I want this change"; skipped = no row
  primary key (response_id, question_id),
  foreign key (poll_id, response_id) references public.feedback_responses (poll_id, id) on delete cascade,
  foreign key (poll_id, question_id) references public.feedback_questions (poll_id, id) on delete restrict
);
create index if not exists feedback_answers_totals_idx
  on public.feedback_answers (poll_id, question_id, wants_change);

-- "Skip" hides the Home announcement for that poll. A skip is not a vote.
create table if not exists public.feedback_skips (
  poll_id uuid not null references public.feedback_polls (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);
create index if not exists feedback_skips_user_idx on public.feedback_skips (user_id);

create table if not exists public.feedback_comment_themes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.feedback_polls (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  term text check (term is null or char_length(term) <= 80),   -- auto-grouping key
  source text not null check (source in ('auto', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feedback_comment_themes_poll_id_id_key unique (poll_id, id)
);
create unique index if not exists feedback_comment_themes_auto_term_key
  on public.feedback_comment_themes (poll_id, term) where source = 'auto';

create table if not exists public.feedback_theme_members (
  theme_id uuid not null,
  poll_id uuid not null,
  response_id uuid not null,
  source text not null check (source in ('auto', 'admin')),
  primary key (theme_id, response_id),             -- a theme counts distinct respondents
  foreign key (poll_id, theme_id) references public.feedback_comment_themes (poll_id, id) on delete cascade,
  foreign key (poll_id, response_id) references public.feedback_responses (poll_id, id) on delete cascade
);
create index if not exists feedback_theme_members_response_idx on public.feedback_theme_members (response_id);

create table if not exists public.feedback_admin_updates (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.feedback_polls (id) on delete cascade,
  position smallint not null default 1 check (position between 1 and 50),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  status text not null default 'reviewing' check (status in ('reviewing', 'planned', 'keeping', 'done')),
  note text check (note is null or char_length(note) <= 600),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_admin_updates_poll_idx on public.feedback_admin_updates (poll_id, position);

-- ---------------------------------------------------------------- guard triggers

create or replace function public.feedback_polls_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.approved_at is not null then
      raise exception 'insert_as_draft' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.approved_at is not null then
      raise exception 'wording_locked' using errcode = 'P0001';
    end if;
    return old;
  end if;
  -- UPDATE
  if new.id is distinct from old.id or new.period_month is distinct from old.period_month then
    raise exception 'wording_locked' using errcode = 'P0001';
  end if;
  if old.approved_at is not null and old.opens_at <= now()
     and (new.opens_at, new.closes_at, new.approved_at) is distinct from (old.opens_at, old.closes_at, old.approved_at) then
    raise exception 'wording_locked' using errcode = 'P0001';
  end if;
  if new.approved_at is not null
     and (old.approved_at is null or new.opens_at is distinct from old.opens_at)
     and new.opens_at <= now() then
    raise exception 'opens_in_past' using errcode = 'P0001';
  end if;
  if new.approved_at is not null and old.approved_at is null
     and not exists (select 1 from public.feedback_questions q where q.poll_id = new.id) then
    raise exception 'no_questions' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace trigger feedback_polls_guard
  before insert or update or delete on public.feedback_polls
  for each row execute function public.feedback_polls_guard();

create or replace function public.feedback_questions_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_poll uuid; v_approved timestamptz; v_found boolean;
begin
  if tg_op = 'DELETE' then
    v_poll := old.poll_id;
  else
    v_poll := new.poll_id;
    if tg_op = 'UPDATE' and new.poll_id is distinct from old.poll_id then
      raise exception 'wording_locked' using errcode = 'P0001';
    end if;
  end if;
  -- "for share" serialises this edit with an approval running at the same time.
  select p.approved_at, true into v_approved, v_found from public.feedback_polls p where p.id = v_poll for share;
  if v_found and v_approved is not null then
    raise exception 'wording_locked' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace trigger feedback_questions_guard
  before insert or update or delete on public.feedback_questions
  for each row execute function public.feedback_questions_guard();

create or replace function public.feedback_responses_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_approved timestamptz; v_opens timestamptz; v_closes timestamptz; v_found boolean;
begin
  if tg_op = 'INSERT' then
    if new.user_id is null or new.voter_key is null then
      raise exception 'ballot_needs_voter' using errcode = 'P0001';
    end if;
    select p.approved_at, p.opens_at, p.closes_at, true into v_approved, v_opens, v_closes, v_found
      from public.feedback_polls p where p.id = new.poll_id for share;
    if not coalesce(v_found, false) or v_approved is null or now() < v_opens then
      raise exception 'poll_not_open' using errcode = 'P0001';
    end if;
    if now() >= v_closes then
      raise exception 'poll_closed' using errcode = 'P0001';
    end if;
    return new;
  end if;
  -- UPDATE: a ballot never changes. The only allowed changes are clearing who wrote it and
  -- the comment (account deletion), forgetting the email key after close, and admin urgent flags.
  if new.id is distinct from old.id or new.poll_id is distinct from old.poll_id
     or new.submitted_at is distinct from old.submitted_at
     or (new.voter_key is distinct from old.voter_key and new.voter_key is not null)
     or (new.user_id is distinct from old.user_id and new.user_id is not null)
     or (new.comment is distinct from old.comment and new.comment is not null) then
    raise exception 'ballot_immutable' using errcode = 'P0001';
  end if;
  if new.voter_key is distinct from old.voter_key then
    -- Forgetting the email key: only for a ballot with no account, once its poll has closed
    -- (while the poll is open the key stops a re-made account voting twice).
    select p.closes_at into v_closes from public.feedback_polls p where p.id = new.poll_id;
    if new.user_id is not null or v_closes is null or now() < v_closes then
      raise exception 'voter_key_in_use' using errcode = 'P0001';
    end if;
  end if;
  if old.user_id is not null and new.user_id is null then
    -- The account is gone: the answers stay in the totals, the comment goes.
    new.comment := null;
    new.urgent_flags := '{}';
    new.urgent_set_by_admin := false;
  end if;
  return new;
end $$;

create or replace trigger feedback_responses_guard
  before insert or update on public.feedback_responses
  for each row execute function public.feedback_responses_guard();

create or replace function public.feedback_responses_forget_comment()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.comment is not null and new.comment is null then
    delete from public.feedback_theme_members m where m.response_id = new.id;
  end if;
  return null;
end $$;

create or replace trigger feedback_responses_forget_comment
  after update on public.feedback_responses
  for each row execute function public.feedback_responses_forget_comment();

create or replace function public.feedback_answers_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'ballot_immutable' using errcode = 'P0001';
end $$;

create or replace trigger feedback_answers_guard
  before update on public.feedback_answers
  for each row execute function public.feedback_answers_guard();

-- Answers are added only with their ballot: in the same transaction that created the
-- response row, while the poll is open. Nothing can be added to an existing or closed ballot.
create or replace function public.feedback_answers_insert_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_xmin text; v_open boolean;
begin
  select r.xmin::text, (p.approved_at is not null and now() >= p.opens_at and now() < p.closes_at)
    into v_xmin, v_open
    from public.feedback_responses r
    join public.feedback_polls p on p.id = r.poll_id
   where r.id = new.response_id and r.poll_id = new.poll_id;
  if v_xmin is null or v_xmin <> (txid_current() % 4294967296)::text then
    raise exception 'ballot_immutable' using errcode = 'P0001';
  end if;
  if not coalesce(v_open, false) then
    raise exception 'poll_closed' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace trigger feedback_answers_insert_guard
  before insert on public.feedback_answers
  for each row execute function public.feedback_answers_insert_guard();

create or replace function public.feedback_touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace trigger feedback_comment_themes_touch
  before update on public.feedback_comment_themes
  for each row execute function public.feedback_touch_updated_at();

create or replace trigger feedback_admin_updates_touch
  before update on public.feedback_admin_updates
  for each row execute function public.feedback_touch_updated_at();

-- ---------------------------------------------------------------- functions the backend calls

-- Saves one ballot (response + answers) in one transaction. A second send for the same
-- account or the same email returns the first ballot (created = false) and changes nothing.
-- Security definer (owner's rights, search_path pinned) because it is the ONLY way to write a
-- ballot: the service role has no direct insert on feedback_responses or feedback_answers.
create or replace function public.feedback_submit(p_poll_id uuid, p_user_id uuid, p_voter_key text,
    p_answers jsonb, p_comment text, p_urgent_flags text[])
returns table (response_id uuid, created boolean, received_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_id uuid; v_at timestamptz;
begin
  -- An existing ballot first: a retry (even after close) is acknowledged, never re-counted.
  select r.id, r.submitted_at into v_id, v_at from public.feedback_responses r
   where r.poll_id = p_poll_id and (r.user_id = p_user_id or r.voter_key = p_voter_key)
   order by r.submitted_at limit 1;
  if found then
    return query select v_id, false, v_at;
    return;
  end if;
  if not exists (select 1 from public.users u where u.id = p_user_id and u.email_verified is true) then
    raise exception 'email_unverified' using errcode = 'P0001';
  end if;
  if p_voter_key is null or p_voter_key !~ '^[0-9a-f]{64}$' then
    raise exception 'ballot_needs_voter' using errcode = 'P0001';
  end if;
  insert into public.feedback_responses (poll_id, user_id, voter_key, comment, urgent_flags)
  values (p_poll_id, p_user_id, p_voter_key, nullif(p_comment, ''), coalesce(p_urgent_flags, '{}'))
  on conflict do nothing
  returning id, submitted_at into v_id, v_at;
  if v_id is null then
    -- A send running at the same time won; READ COMMITTED sees its row now.
    select r.id, r.submitted_at into v_id, v_at from public.feedback_responses r
     where r.poll_id = p_poll_id and (r.user_id = p_user_id or r.voter_key = p_voter_key)
     order by r.submitted_at limit 1;
    return query select v_id, false, v_at;
    return;
  end if;
  -- Any bad answer (duplicate question, a question from another poll, a bad value) raises
  -- and rolls back the whole ballot, response row included.
  insert into public.feedback_answers (response_id, poll_id, question_id, wants_change)
  select v_id, p_poll_id, (e->>'question_id')::uuid, (e->>'wants_change')::boolean
    from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) e;
  return query select v_id, true, v_at;
end $$;

-- After a poll closes, anonymous ballots (account deleted) no longer need the email key that
-- stopped a re-made account voting twice. Clears it; returns how many were cleared. Safe to
-- run any time and as often as you like.
create or replace function public.feedback_forget_voter_keys()
returns integer
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_count integer;
begin
  update public.feedback_responses r
     set voter_key = null
    from public.feedback_polls p
   where p.id = r.poll_id and p.closes_at <= now()
     and r.user_id is null and r.voter_key is not null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Replaces a DRAFT poll's questions in one transaction.
create or replace function public.feedback_save_questions(p_poll_id uuid, p_labels text[])
returns integer
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_count integer;
begin
  perform 1 from public.feedback_polls p where p.id = p_poll_id and p.approved_at is null for update;
  if not found then
    raise exception 'wording_locked' using errcode = 'P0001';
  end if;
  delete from public.feedback_questions q where q.poll_id = p_poll_id;
  insert into public.feedback_questions (poll_id, position, label)
  select p_poll_id, t.ord::smallint, btrim(t.label)
    from unnest(p_labels) with ordinality as t(label, ord);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Yes/No counts per question and the number of ballots. One statement, so the PostgREST
-- row cap can never cut totals short.
create or replace function public.feedback_totals(p_poll_id uuid)
returns table (question_id uuid, "position" smallint, label text, yes_count integer, no_count integer,
               participants integer)
language sql stable security invoker set search_path = public, pg_temp as $$
  select q.id, q.position, q.label,
         (count(a.question_id) filter (where a.wants_change))::integer,
         (count(a.question_id) filter (where not a.wants_change))::integer,
         (select count(*) from public.feedback_responses r where r.poll_id = p_poll_id)::integer
    from public.feedback_questions q
    left join public.feedback_answers a on a.poll_id = q.poll_id and a.question_id = q.id
   where q.poll_id = p_poll_id
   group by q.id, q.position, q.label
   order by q.position
$$;

-- ---------------------------------------------------------------- security

alter table public.feedback_polls enable row level security;
alter table public.feedback_questions enable row level security;
alter table public.feedback_responses enable row level security;
alter table public.feedback_answers enable row level security;
alter table public.feedback_skips enable row level security;
alter table public.feedback_comment_themes enable row level security;
alter table public.feedback_theme_members enable row level security;
alter table public.feedback_admin_updates enable row level security;

do $$
declare
  t text;
  f text;
  tables text[] := array['feedback_polls', 'feedback_questions', 'feedback_responses', 'feedback_answers',
                         'feedback_skips', 'feedback_comment_themes', 'feedback_theme_members',
                         'feedback_admin_updates'];
  funcs text[] := array['feedback_polls_guard()', 'feedback_questions_guard()', 'feedback_responses_guard()',
                        'feedback_responses_forget_comment()', 'feedback_answers_guard()',
                        'feedback_answers_insert_guard()', 'feedback_touch_updated_at()',
                        'feedback_submit(uuid, uuid, text, jsonb, text, text[])',
                        'feedback_forget_voter_keys()',
                        'feedback_save_questions(uuid, text[])', 'feedback_totals(uuid)'];
begin
  foreach t in array tables loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table public.%I from authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      -- Supabase's default privileges give service_role everything; start from nothing.
      execute format('revoke all on table public.%I from service_role', t);
    end if;
  end loop;
  foreach f in array funcs loop
    execute format('revoke execute on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function public.%s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function public.%s from authenticated', f);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.feedback_polls to service_role';
    execute 'grant select, insert, update, delete on table public.feedback_questions to service_role';
    -- Ballots: written only through feedback_submit (no direct insert), never deleted; updates
    -- only to clear who wrote it / the comment / the email key after close, and admin urgent flags.
    execute 'grant select on table public.feedback_responses to service_role';
    execute 'grant update (user_id, voter_key, comment, urgent_flags, urgent_set_by_admin) on table public.feedback_responses to service_role';
    execute 'grant select on table public.feedback_answers to service_role';
    execute 'grant select, insert, delete on table public.feedback_skips to service_role';
    execute 'grant select, insert, update, delete on table public.feedback_comment_themes to service_role';
    execute 'grant select, insert, update, delete on table public.feedback_theme_members to service_role';
    execute 'grant select, insert, update, delete on table public.feedback_admin_updates to service_role';
    execute 'grant execute on function public.feedback_submit(uuid, uuid, text, jsonb, text, text[]) to service_role';
    execute 'grant execute on function public.feedback_forget_voter_keys() to service_role';
    execute 'grant execute on function public.feedback_save_questions(uuid, text[]) to service_role';
    execute 'grant execute on function public.feedback_totals(uuid) to service_role';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
