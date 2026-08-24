alter table if exists public.profiles
add column if not exists role text not null default 'user',
add column if not exists theme_color text,
add column if not exists theme_mode text;

update public.profiles
set role = 'user'
where role is null;
