create extension if not exists "uuid-ossp";

create table if not exists public.notes (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(user_id),
  title text not null,
  content text not null,
  tags text[] not null default '{}'::text[],
  created_at timestamp default now()
);

alter table public.notes
  add column if not exists title text,
  add column if not exists content text,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists created_at timestamp default now();

create index if not exists notes_user_id_created_at_idx
  on public.notes (user_id, created_at desc);
