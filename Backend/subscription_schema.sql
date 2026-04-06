alter table if exists public.profiles
add column if not exists subscription_status text not null default 'free';

update public.profiles
set subscription_status = 'free'
where subscription_status is null;
