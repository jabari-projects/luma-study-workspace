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
