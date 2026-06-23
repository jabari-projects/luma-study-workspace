create extension if not exists "uuid-ossp";

create table if not exists public.study_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(user_id),
  name text not null,
  subject text,
  notes text,
  duration_seconds integer not null default 0,
  created_at timestamp default now(),
  updated_at timestamptz default now()
);

alter table public.study_sessions
  add column if not exists name text,
  add column if not exists subject text,
  add column if not exists notes text,
  add column if not exists duration_seconds integer not null default 0,
  add column if not exists created_at timestamp default now(),
  add column if not exists updated_at timestamptz default now();

create index if not exists study_sessions_user_id_created_at_idx
  on public.study_sessions (user_id, created_at desc);

create index if not exists study_sessions_updated_at_idx
  on public.study_sessions (updated_at desc);
