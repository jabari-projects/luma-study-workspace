-- 2026-11-24: a subject and subtopic on notes, decks and summaries, and one search for Discover. NOT APPLIED.
-- Run only with the owner's OK, after a fresh verified backup (docs/deployment-checklist.md),
-- after the three release-1 files (2026_11_18 feedback, 2026_11_19 maintenance, 2026_11_19 student work).
-- Additive: new nullable columns (no default, nothing backfilled), light shape checks that every
-- existing row already passes (all new columns are null), partial indexes and one read-only
-- search function. No existing row or value changes, nothing is dropped or renamed. Safe to run twice.
--
-- subject_slug, subtopic_slug  slugs from backend/app/data/subjects.json (the API checks the real
--                               list; the database only checks the shape). Null = "No subject".
-- public_study_search(...)     Discover search: shared items only, matched on title, text, every
--                               card, tags and subject names, plus counts per subject, subtopic and
--                               type (never per person). Only the service role may run it; the API
--                               swaps each owner id for the current username and never sends the id.
--
-- The code that uses these is deployed AFTER this file runs. Old code ignores the columns and the
-- function, so rolling the code back is safe. The search_vector triggers are not touched.

begin;

-- Fail fast instead of queueing every student's save behind a lock: if another session holds
-- one of these tables, or a step runs long, the whole file rolls back with nothing changed.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.notes      add column if not exists subject_slug text;
alter table public.notes      add column if not exists subtopic_slug text;
alter table public.flashcards add column if not exists subject_slug text;
alter table public.flashcards add column if not exists subtopic_slug text;
alter table public.summaries  add column if not exists subject_slug text;
alter table public.summaries  add column if not exists subtopic_slug text;

-- Shape checks only. Added NOT VALID, then validated (every existing row has both columns null,
-- so validation can't fail on old data). A check that already exists is left alone.
do $shape$
declare
  t text;
begin
  foreach t in array array['notes', 'flashcards', 'summaries'] loop
    if not exists (select 1 from pg_constraint where conrelid = format('public.%I', t)::regclass
                    and conname = t || '_subject_slug_shape') then
      execute format(
        'alter table public.%I add constraint %I check (subject_slug is null or (subject_slug ~ %L and length(subject_slug) <= 40)) not valid',
        t, t || '_subject_slug_shape', '^[a-z0-9]+(-[a-z0-9]+)*$');
      execute format('alter table public.%I validate constraint %I', t, t || '_subject_slug_shape');
    end if;
    if not exists (select 1 from pg_constraint where conrelid = format('public.%I', t)::regclass
                    and conname = t || '_subtopic_slug_shape') then
      execute format(
        'alter table public.%I add constraint %I check (subtopic_slug is null or (subject_slug is not null and subtopic_slug ~ %L and length(subtopic_slug) <= 40)) not valid',
        t, t || '_subtopic_slug_shape', '^[a-z0-9]+(-[a-z0-9]+)*$');
      execute format('alter table public.%I validate constraint %I', t, t || '_subtopic_slug_shape');
    end if;
  end loop;
end
$shape$;

-- Discover reads shared rows only, newest first, often by subject.
create index if not exists notes_public_subject_idx      on public.notes      (subject_slug, subtopic_slug, published_at desc) where is_public;
create index if not exists flashcards_public_subject_idx on public.flashcards (subject_slug, subtopic_slug, published_at desc) where is_public;
create index if not exists summaries_public_subject_idx  on public.summaries  (subject_slug, subtopic_slug, published_at desc) where is_public;

-- One search for Discover. Reads only; shared items with a title only.
--   p_pattern      an ilike pattern the API built from the search words (%, _ and \ escaped), or null for all
--   p_match_pairs  [{"subject": "math", "subtopic": "algebra" | null}, ...]: items in these subjects
--                  match too (the API finds them by subject name or alias), or [] for none
--   p_subject, p_subtopic, p_type  the chosen filters, or null
--   p_user_ids     only these owners (people search), or null for everyone
-- Answer: {"total", "rows", "subjects", "subtopics", "types"}. total and rows follow every filter.
-- subjects ignores the chosen subject and subtopic; subtopics (only with a subject) ignores the
-- chosen subtopic; types ignores the chosen type. Counts are per subject or type, never per person.
create or replace function public.public_study_search(
  p_pattern text,
  p_match_pairs jsonb,
  p_subject text,
  p_subtopic text,
  p_type text,
  p_user_ids uuid[],
  p_limit integer,
  p_offset integer)
returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  with shared as (
    select 'note'::text as study_type, n.id, n.user_id, n.title, left(coalesce(n.content, ''), 1000) as body,
           n.tags, n.subject_slug, n.subtopic_slug, n.published_at, n.created_at,
           concat_ws(' ', n.title, n.content, array_to_string(n.tags, ' ')) as hay
      from public.notes n
     where n.is_public and btrim(coalesce(n.title, '')) <> ''
    union all
    select 'flashcards'::text, f.id, f.user_id, f.title, coalesce(nullif(f.front, ''), f.back, ''),
           f.tags, f.subject_slug, f.subtopic_slug, f.published_at, f.created_at,
           concat_ws(' ', f.title, f.front, f.back, array_to_string(f.tags, ' '),
             (select string_agg(concat_ws(' ', c.value ->> 'front', c.value ->> 'back'), ' ')
                from jsonb_array_elements(case when jsonb_typeof(f.cards) = 'array' then f.cards else '[]'::jsonb end) c))
      from public.flashcards f
     where f.is_public and btrim(coalesce(f.title, '')) <> ''
    union all
    select 'summary'::text, s.id, s.user_id, s.title, left(coalesce(s.content, ''), 1000),
           s.tags, s.subject_slug, s.subtopic_slug, s.published_at, s.created_at,
           concat_ws(' ', s.title, s.content, array_to_string(s.tags, ' '))
      from public.summaries s
     where s.is_public and btrim(coalesce(s.title, '')) <> ''
  ),
  matched as (
    select sh.* from shared sh
     where (p_user_ids is null or sh.user_id = any(p_user_ids))
       and (p_pattern is null
            or sh.hay ilike p_pattern escape '\'
            or exists (select 1 from jsonb_array_elements(coalesce(p_match_pairs, '[]'::jsonb)) m
                        where m.value ->> 'subject' = sh.subject_slug
                          and (m.value ->> 'subtopic' is null or m.value ->> 'subtopic' = sh.subtopic_slug)))
  ),
  chosen as (
    select * from matched
     where (p_subject is null or subject_slug = p_subject)
       and (p_subtopic is null or subtopic_slug = p_subtopic)
       and (p_type is null or study_type = p_type)
  ),
  page as (
    select study_type, id, user_id, title, body, tags, subject_slug, subtopic_slug, published_at, created_at
      from chosen
     order by published_at desc nulls last, created_at desc, id
     limit greatest(least(coalesce(p_limit, 30), 500), 0)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from chosen),
    'rows', coalesce((select jsonb_agg(to_jsonb(pg) order by pg.published_at desc nulls last, pg.created_at desc, pg.id) from page pg), '[]'::jsonb),
    'subjects', coalesce((
      select jsonb_agg(jsonb_build_object('slug', x.slug, 'count', x.n) order by x.n desc, x.slug nulls last)
        from (select subject_slug as slug, count(*) as n from matched
               where p_type is null or study_type = p_type group by subject_slug) x), '[]'::jsonb),
    'subtopics', case when p_subject is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('slug', x.slug, 'count', x.n) order by x.n desc, x.slug nulls last)
        from (select subtopic_slug as slug, count(*) as n from matched
               where subject_slug = p_subject and (p_type is null or study_type = p_type) group by subtopic_slug) x), '[]'::jsonb) end,
    'types', coalesce((
      select jsonb_agg(jsonb_build_object('type', x.study_type, 'count', x.n) order by x.n desc, x.study_type)
        from (select study_type, count(*) as n from matched
               where (p_subject is null or subject_slug = p_subject) and (p_subtopic is null or subtopic_slug = p_subtopic)
               group by study_type) x), '[]'::jsonb))
$$;

-- Only the API (service role) may run it: never anyone signed out, never a browser directly.
do $grants$
begin
  execute 'revoke execute on function public.public_study_search(text, jsonb, text, text, text, uuid[], integer, integer) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.public_study_search(text, jsonb, text, text, text, uuid[], integer, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function public.public_study_search(text, jsonb, text, text, text, uuid[], integer, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.public_study_search(text, jsonb, text, text, text, uuid[], integer, integer) to service_role';
  end if;
end
$grants$;

-- Hard stop: "if not exists" skips a column, check or index that is already there. If production
-- ever got one by hand with another shape, the new code would break, so stop here (everything
-- above rolls back) instead of carrying on.
do $guard$
declare
  bad text;
begin
  select string_agg(format('%s.%s', w.t, w.c), ', ') into bad
    from (values ('notes', 'subject_slug'), ('notes', 'subtopic_slug'), ('flashcards', 'subject_slug'),
                 ('flashcards', 'subtopic_slug'), ('summaries', 'subject_slug'), ('summaries', 'subtopic_slug')) as w(t, c)
    left join information_schema.columns col
      on col.table_schema = 'public' and col.table_name = w.t and col.column_name = w.c
   where col.column_name is null or col.data_type <> 'text' or col.is_nullable <> 'YES' or col.column_default is not null;
  if bad is not null then
    raise exception 'subject columns are not as expected: %', bad;
  end if;
  select string_agg(t.t || k.k, ', ') into bad
    from (values ('notes'), ('flashcards'), ('summaries')) as t(t)
    cross join (values ('_subject_slug_shape'), ('_subtopic_slug_shape')) as k(k)
    left join pg_constraint c on c.conrelid = format('public.%I', t.t)::regclass and c.conname = t.t || k.k
   where c.oid is null or c.contype <> 'c' or not c.convalidated
      or pg_get_constraintdef(c.oid) not like '%^[a-z0-9]+(-[a-z0-9]+)*$%'
      or (k.k = '_subtopic_slug_shape' and pg_get_constraintdef(c.oid) not like '%subject_slug IS NOT NULL%');
  if bad is not null then
    raise exception 'subject checks are not as expected: %', bad;
  end if;
  select string_agg(w.t, ', ') into bad
    from (values ('notes'), ('flashcards'), ('summaries')) as w(t)
    left join pg_indexes i on i.schemaname = 'public' and i.indexname = w.t || '_public_subject_idx'
   where i.indexdef is null
      or i.indexdef not like '%(subject_slug, subtopic_slug, published_at DESC) WHERE is_public';
  if bad is not null then
    raise exception 'subject indexes are not as expected: %', bad;
  end if;
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.public_study_search(text, jsonb, text, text, text, uuid[], integer, integer)'::regprocedure
       and not p.prosecdef and p.provolatile = 's' and p.prorettype = 'jsonb'::regtype) then
    raise exception 'public_study_search is not as expected';
  end if;
end
$guard$;

commit;

notify pgrst, 'reload schema';

-- VERIFY (run after applying; read-only, counts and names only):
--   select table_name, column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and column_name in ('subject_slug', 'subtopic_slug')
--      and table_name in ('notes', 'flashcards', 'summaries')
--    order by 1, 2;
--   -- expect 6 rows: text, YES, no default
--   select conname from pg_constraint where conname like '%_slug_shape' and convalidated order by 1;
--   -- expect 6 rows
--   select indexname from pg_indexes where schemaname = 'public' and indexname like '%_public_subject_idx' order by 1;
--   -- expect 3 rows
--   select count(*) from public.notes where subject_slug is not null;  -- expect 0 right after applying
--   select has_function_privilege('anon', 'public.public_study_search(text, jsonb, text, text, text, uuid[], integer, integer)', 'execute');
--   -- expect false
