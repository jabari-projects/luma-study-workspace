-- 2026-11-19: edit versions and safe retries for student work. NOT APPLIED.
-- Run only with the owner's OK, after a fresh verified backup (docs/deployment-checklist.md).
-- Additive: new columns with defaults + partial unique indexes. No existing row or value
-- changes, nothing is dropped or renamed. Safe to run twice.
--
-- version       goes up by 1 on every saved edit. The app sends the version it loaded
--               (expected_version), so a save from an older tab can't quietly overwrite
--               newer work (it gets "changed in another tab" instead).
-- create_key    the Idempotency-Key a browser sent with a new item. A retried create with
--               the same key returns the first row instead of making a copy. The index is
--               per user, so one student's key can never match another student's row.
-- progress_rev  flashcards only: goes up when review progress is merged in, so studying
--               never conflicts with an open deck editor.
--
-- The code that uses these columns (backend/app/edit_versions.py) is deployed AFTER this
-- file runs. Old code ignores the columns, so rolling the code back is safe.

begin;

-- Fail fast instead of queueing every student's save behind a lock: if another session holds
-- one of these tables, or a step runs long, the whole file rolls back with nothing changed.
-- It is safe to run again (docs/deployment-checklist.md).
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.notes          add column if not exists version bigint not null default 1;
alter table public.notes          add column if not exists create_key uuid;
alter table public.summaries      add column if not exists version bigint not null default 1;
alter table public.summaries      add column if not exists create_key uuid;
alter table public.flashcards     add column if not exists version bigint not null default 1;
alter table public.flashcards     add column if not exists create_key uuid;
alter table public.flashcards     add column if not exists progress_rev bigint not null default 0;
alter table public.study_sessions add column if not exists version bigint not null default 1;
alter table public.study_sessions add column if not exists create_key uuid;

create unique index if not exists notes_user_create_key_uidx          on public.notes (user_id, create_key) where create_key is not null;
create unique index if not exists summaries_user_create_key_uidx      on public.summaries (user_id, create_key) where create_key is not null;
create unique index if not exists flashcards_user_create_key_uidx     on public.flashcards (user_id, create_key) where create_key is not null;
create unique index if not exists study_sessions_user_create_key_uidx on public.study_sessions (user_id, create_key) where create_key is not null;

-- Hard stop: "if not exists" skips a column or index that is already there. If production
-- ever got one by hand with another type, nullability, default or shape, the new code would
-- break, so stop here (everything above rolls back) instead of carrying on.
do $guard$
declare
  bad text;
begin
  select string_agg(format('%s.%s', w.t, w.c), ', ') into bad
    from (values
      ('notes', 'version', 'bigint', 'NO', '1'), ('summaries', 'version', 'bigint', 'NO', '1'),
      ('flashcards', 'version', 'bigint', 'NO', '1'), ('study_sessions', 'version', 'bigint', 'NO', '1'),
      ('notes', 'create_key', 'uuid', 'YES', null), ('summaries', 'create_key', 'uuid', 'YES', null),
      ('flashcards', 'create_key', 'uuid', 'YES', null), ('study_sessions', 'create_key', 'uuid', 'YES', null),
      ('flashcards', 'progress_rev', 'bigint', 'NO', '0')
    ) as w(t, c, typ, nullable, def)
    left join information_schema.columns col
      on col.table_schema = 'public' and col.table_name = w.t and col.column_name = w.c
   where col.column_name is null or col.data_type <> w.typ or col.is_nullable <> w.nullable
      or col.column_default is distinct from w.def;
  if bad is not null then
    raise exception 'student work columns are not as expected: %', bad;
  end if;
  select string_agg(w.t, ', ') into bad
    from (values ('notes'), ('summaries'), ('flashcards'), ('study_sessions')) as w(t)
    left join pg_indexes i on i.schemaname = 'public' and i.indexname = w.t || '_user_create_key_uidx'
   where i.indexdef is null
      or i.indexdef not like 'CREATE UNIQUE INDEX%(user_id, create_key) WHERE (create_key IS NOT NULL)';
  if bad is not null then
    raise exception 'create_key indexes are not as expected: %', bad;
  end if;
end
$guard$;

commit;

notify pgrst, 'reload schema';

-- VERIFY (run after applying; read-only, counts and names only):
--   select table_name, column_name, column_default, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and column_name in ('version', 'create_key', 'progress_rev')
--      and table_name in ('notes', 'summaries', 'flashcards', 'study_sessions')
--    order by 1, 2;
--   -- expect 9 rows: version default 1 not null (4), create_key nullable (4), progress_rev default 0 not null (1)
--   select indexname from pg_indexes where schemaname = 'public' and indexname like '%_user_create_key_uidx' order by 1;
--   -- expect 4 rows
--   select count(*) from public.notes where version is null;  -- expect 0
