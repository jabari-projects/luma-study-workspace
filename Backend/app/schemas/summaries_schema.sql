create extension if not exists "uuid-ossp";

create table if not exists public.summaries (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(user_id),
  title text,
  content text not null,
  is_public boolean not null default false,
  published_at timestamptz,
  published_by text,
  study_type text not null default 'summary',
  created_at timestamp default now()
);

alter table public.summaries
  add column if not exists title text,
  add column if not exists content text,
  add column if not exists is_public boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists study_type text not null default 'summary',
  add column if not exists created_at timestamp default now();

create index if not exists summaries_user_id_created_at_idx
  on public.summaries (user_id, created_at desc);

create index if not exists summaries_is_public_created_at_idx
  on public.summaries (is_public, created_at desc);

create index if not exists summaries_published_at_idx
  on public.summaries (published_at desc);
