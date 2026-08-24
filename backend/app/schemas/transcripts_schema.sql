create extension if not exists "uuid-ossp";

create table if not exists public.transcripts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(user_id),
  content text not null,
  created_at timestamp default now(),
  updated_at timestamptz default now()
);

alter table public.transcripts
  add column if not exists content text,
  add column if not exists created_at timestamp default now(),
  add column if not exists updated_at timestamptz default now();

create index if not exists transcripts_user_id_created_at_idx
  on public.transcripts (user_id, created_at desc);

create index if not exists transcripts_updated_at_idx
  on public.transcripts (updated_at desc);
