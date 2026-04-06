alter table if exists public.profiles
add column if not exists role text not null default 'user';

update public.profiles
set role = 'user'
where role is null;
