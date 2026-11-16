create extension if not exists "uuid-ossp";

create table if not exists public.flashcards (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(user_id),
  title text,
  front text not null,
  back text not null,
  tags text[] not null default '{}'::text[],
  is_public boolean not null default false,
  published_at timestamptz,
  published_by text,
  study_type text not null default 'flashcards',
  created_at timestamp default now(),
  updated_at timestamptz default now()
);

alter table public.flashcards
  add column if not exists title text,
  add column if not exists front text,
  add column if not exists back text,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists is_public boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists study_type text not null default 'flashcards',
  add column if not exists created_at timestamp default now(),
  add column if not exists updated_at timestamptz default now();

create index if not exists flashcards_user_id_created_at_idx
  on public.flashcards (user_id, created_at desc);

create index if not exists flashcards_is_public_created_at_idx
  on public.flashcards (is_public, created_at desc);

create index if not exists flashcards_published_at_idx
  on public.flashcards (published_at desc);

create index if not exists flashcards_updated_at_idx
  on public.flashcards (updated_at desc);

-- Decks: one flashcards row holds many cards plus each card's review schedule.
alter table public.flashcards
  add column if not exists cards jsonb not null default '[]'::jsonb;

update public.flashcards
set cards = jsonb_build_array(
  jsonb_build_object('id', id::text || '-0', 'front', front, 'back', back, 'review', null)
)
where (cards is null or cards = '[]'::jsonb) and front is not null and back is not null;
