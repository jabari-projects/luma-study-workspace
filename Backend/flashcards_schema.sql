create extension if not exists "uuid-ossp";

create table if not exists public.flashcards (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(user_id),
  front text not null,
  back text not null,
  tags text[] not null default '{}'::text[],
  created_at timestamp default now()
);

alter table public.flashcards
  add column if not exists front text,
  add column if not exists back text,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists created_at timestamp default now();

create index if not exists flashcards_user_id_created_at_idx
  on public.flashcards (user_id, created_at desc);
