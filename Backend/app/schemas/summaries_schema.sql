create extension if not exists "uuid-ossp";

create table if not exists public.summaries (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(user_id),
  content text not null,
  created_at timestamp default now()
);

alter table public.summaries
  add column if not exists content text,
  add column if not exists created_at timestamp default now();

create index if not exists summaries_user_id_created_at_idx
  on public.summaries (user_id, created_at desc);
