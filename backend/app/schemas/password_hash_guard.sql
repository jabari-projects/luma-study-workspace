-- Password hash guard (rollout safety).
--
-- Install this AFTER the hashing login code is deployed everywhere and BEFORE running
-- backend/scripts/hash_existing_passwords.py --apply.
--
-- What it does: any INSERT or UPDATE that writes a non-empty password that is not an
-- argon2 hash is rejected by the database itself. If an old backend instance (which
-- stored plain text) is still running during or after a deploy, its signup or reset
-- fails loudly instead of quietly writing a plain-text password. That makes the old and
-- new login code unable to overlap unsafely.
--
-- Existing plain-text rows are NOT touched by this file; they stay readable until the
-- migration script hashes them. The migration script refuses to run --apply unless
-- public.luma_password_guard_installed() returns true.
--
-- Safe to run more than once.

create or replace function public.luma_reject_plaintext_password()
returns trigger
language plpgsql
as $$
begin
  if new.password is not null
     and new.password <> ''
     and new.password not like '$argon2%' then
    raise exception 'Refusing to store a password that is not an argon2 hash'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists luma_password_hash_guard on public.users;
create trigger luma_password_hash_guard
before insert or update of password on public.users
for each row execute function public.luma_reject_plaintext_password();

-- Lets the migration script confirm the guard is in place (service role only).
create or replace function public.luma_password_guard_installed()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'users'
      and t.tgname = 'luma_password_hash_guard'
      and not t.tgisinternal
      and t.tgenabled <> 'D'
  );
$$;

revoke all on function public.luma_password_guard_installed() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.luma_password_guard_installed() to service_role';
  end if;
end $$;
