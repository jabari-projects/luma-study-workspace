create extension if not exists "uuid-ossp";

do $$
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'notes'
  ) then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'profiles'
        and column_name = 'id'
    ) then
      execute '
        create table public.notes (
          id uuid primary key default uuid_generate_v4(),
          user_id uuid references public.profiles(id),
          title text,
          content text,
          tags text[] default ''{}''::text[],
          is_public boolean not null default false,
          published_at timestamptz,
          published_by text,
          study_type text not null default ''note'',
          search_vector tsvector,
          created_at timestamp default now(),
          updated_at timestamptz default now()
        )
      ';
    elsif exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'profiles'
        and column_name = 'user_id'
    ) then
      execute '
        create table public.notes (
          id uuid primary key default uuid_generate_v4(),
          user_id uuid references public.profiles(user_id),
          title text,
          content text,
          tags text[] default ''{}''::text[],
          is_public boolean not null default false,
          published_at timestamptz,
          published_by text,
          study_type text not null default ''note'',
          search_vector tsvector,
          created_at timestamp default now(),
          updated_at timestamptz default now()
        )
      ';
    else
      raise exception 'Could not create public.notes because public.profiles has neither id nor user_id.';
    end if;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'summaries'
  ) then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'profiles'
        and column_name = 'id'
    ) then
      execute '
        create table public.summaries (
          id uuid primary key default uuid_generate_v4(),
          user_id uuid references public.profiles(id),
          title text,
          content text,
          tags text[] default ''{}''::text[],
          is_public boolean not null default false,
          published_at timestamptz,
          published_by text,
          study_type text not null default ''summary'',
          search_vector tsvector,
          created_at timestamp default now(),
          updated_at timestamptz default now()
        )
      ';
    elsif exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'profiles'
        and column_name = 'user_id'
    ) then
      execute '
        create table public.summaries (
          id uuid primary key default uuid_generate_v4(),
          user_id uuid references public.profiles(user_id),
          title text,
          content text,
          tags text[] default ''{}''::text[],
          is_public boolean not null default false,
          published_at timestamptz,
          published_by text,
          study_type text not null default ''summary'',
          search_vector tsvector,
          created_at timestamp default now(),
          updated_at timestamptz default now()
        )
      ';
    else
      raise exception 'Could not create public.summaries because public.profiles has neither id nor user_id.';
    end if;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'transcripts'
  ) then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'profiles'
        and column_name = 'id'
    ) then
      execute '
        create table public.transcripts (
          id uuid primary key default uuid_generate_v4(),
          user_id uuid references public.profiles(id),
          content text,
          search_vector tsvector,
          created_at timestamp default now()
        )
      ';
    elsif exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'profiles'
        and column_name = 'user_id'
    ) then
      execute '
        create table public.transcripts (
          id uuid primary key default uuid_generate_v4(),
          user_id uuid references public.profiles(user_id),
          content text,
          search_vector tsvector,
          created_at timestamp default now()
        )
      ';
    else
      raise exception 'Could not create public.transcripts because public.profiles has neither id nor user_id.';
    end if;
  end if;
end $$;

alter table if exists public.flashcards
  add column if not exists title text,
  add column if not exists tags text[] default '{}'::text[],
  add column if not exists is_public boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists study_type text not null default 'flashcards',
  add column if not exists search_vector tsvector,
  add column if not exists updated_at timestamptz default now();

alter table if exists public.study_sessions
  add column if not exists name text,
  add column if not exists subject text,
  add column if not exists notes text,
  add column if not exists search_vector tsvector,
  add column if not exists updated_at timestamptz default now();

alter table if exists public.notes
  add column if not exists title text,
  add column if not exists content text,
  add column if not exists tags text[] default '{}'::text[],
  add column if not exists is_public boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists study_type text not null default 'note',
  add column if not exists search_vector tsvector,
  add column if not exists updated_at timestamptz default now();

alter table if exists public.summaries
  add column if not exists title text,
  add column if not exists content text,
  add column if not exists tags text[] default '{}'::text[],
  add column if not exists is_public boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists study_type text not null default 'summary',
  add column if not exists search_vector tsvector,
  add column if not exists updated_at timestamptz default now();

alter table if exists public.transcripts
  add column if not exists content text,
  add column if not exists search_vector tsvector,
  add column if not exists updated_at timestamptz default now();

create or replace function public.notes_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'english',
      coalesce(new.title, '') || ' ' ||
      coalesce(new.content, '') || ' ' ||
      coalesce(array_to_string(new.tags, ' '), '')
    );
  return new;
end;
$$;

create or replace function public.flashcards_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'english',
      coalesce(new.title, '') || ' ' ||
      coalesce(new.front, '') || ' ' ||
      coalesce(new.back, '') || ' ' ||
      coalesce(array_to_string(new.tags, ' '), '')
    );
  return new;
end;
$$;

create or replace function public.study_sessions_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'english',
      coalesce(new.name, '') || ' ' ||
      coalesce(new.subject, '') || ' ' ||
      coalesce(new.notes, '')
    );
  return new;
end;
$$;

create or replace function public.summaries_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'english',
      coalesce(new.title, '') || ' ' ||
      coalesce(new.content, '') || ' ' ||
      coalesce(array_to_string(new.tags, ' '), '')
    );
  return new;
end;
$$;

create or replace function public.transcripts_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.content, ''));
  return new;
end;
$$;

drop trigger if exists notes_search_update on public.notes;
create trigger notes_search_update
before insert or update on public.notes
for each row execute function public.notes_search_vector_trigger();

drop trigger if exists flashcards_search_update on public.flashcards;
create trigger flashcards_search_update
before insert or update on public.flashcards
for each row execute function public.flashcards_search_vector_trigger();

drop trigger if exists study_sessions_search_update on public.study_sessions;
create trigger study_sessions_search_update
before insert or update on public.study_sessions
for each row execute function public.study_sessions_search_vector_trigger();

drop trigger if exists summaries_search_update on public.summaries;
create trigger summaries_search_update
before insert or update on public.summaries
for each row execute function public.summaries_search_vector_trigger();

drop trigger if exists transcripts_search_update on public.transcripts;
create trigger transcripts_search_update
before insert or update on public.transcripts
for each row execute function public.transcripts_search_vector_trigger();

update public.notes
set search_vector =
  to_tsvector(
    'english',
    coalesce(title, '') || ' ' ||
    coalesce(content, '') || ' ' ||
    coalesce(array_to_string(tags, ' '), '')
  )
where true;

update public.flashcards
set search_vector =
  to_tsvector(
    'english',
    coalesce(title, '') || ' ' ||
    coalesce(front, '') || ' ' ||
    coalesce(back, '') || ' ' ||
    coalesce(array_to_string(tags, ' '), '')
  )
where true;

update public.study_sessions
set search_vector =
  to_tsvector(
    'english',
    coalesce(name, '') || ' ' ||
    coalesce(subject, '') || ' ' ||
    coalesce(notes, '')
  )
where true;

update public.summaries
set search_vector =
  to_tsvector(
    'english',
    coalesce(title, '') || ' ' ||
    coalesce(content, '') || ' ' ||
    coalesce(array_to_string(tags, ' '), '')
  )
where true;

update public.transcripts
set search_vector = to_tsvector('english', coalesce(content, ''))
where true;

create index if not exists notes_user_id_created_at_idx
  on public.notes (user_id, created_at desc);
create index if not exists flashcards_user_id_created_at_idx
  on public.flashcards (user_id, created_at desc);
create index if not exists study_sessions_user_id_created_at_idx
  on public.study_sessions (user_id, created_at desc);
create index if not exists summaries_user_id_created_at_idx
  on public.summaries (user_id, created_at desc);
create index if not exists transcripts_user_id_created_at_idx
  on public.transcripts (user_id, created_at desc);

create index if not exists notes_is_public_created_at_idx
  on public.notes (is_public, created_at desc);
create index if not exists flashcards_is_public_created_at_idx
  on public.flashcards (is_public, created_at desc);
create index if not exists summaries_is_public_created_at_idx
  on public.summaries (is_public, created_at desc);

create index if not exists notes_published_at_idx
  on public.notes (published_at desc);
create index if not exists flashcards_published_at_idx
  on public.flashcards (published_at desc);
create index if not exists summaries_published_at_idx
  on public.summaries (published_at desc);

create index if not exists notes_updated_at_idx
  on public.notes (updated_at desc);
create index if not exists flashcards_updated_at_idx
  on public.flashcards (updated_at desc);
create index if not exists study_sessions_updated_at_idx
  on public.study_sessions (updated_at desc);
create index if not exists summaries_updated_at_idx
  on public.summaries (updated_at desc);
create index if not exists transcripts_updated_at_idx
  on public.transcripts (updated_at desc);

create index if not exists notes_search_idx
  on public.notes using gin (search_vector);
create index if not exists flashcards_search_idx
  on public.flashcards using gin (search_vector);
create index if not exists study_sessions_search_idx
  on public.study_sessions using gin (search_vector);
create index if not exists summaries_search_idx
  on public.summaries using gin (search_vector);
create index if not exists transcripts_search_idx
  on public.transcripts using gin (search_vector);
