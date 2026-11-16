create extension if not exists "uuid-ossp";

-- Older Luma builds used public.ai_usage as a rolling counter table for rate
-- limiting. If that legacy shape is present, archive it first so the new
-- event-log table can power both rate limiting and dashboard analytics.
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'ai_usage'
  ) and (
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'ai_usage'
        and column_name = 'id'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'ai_usage'
        and column_name = 'type'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'ai_usage'
        and column_name = 'created_at'
    )
  ) then
    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'ai_usage_legacy'
    ) then
      raise exception 'public.ai_usage uses the legacy counter schema and public.ai_usage_legacy already exists.';
    end if;

    execute 'alter table public.ai_usage rename to ai_usage_legacy';
  end if;

  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'ai_usage'
  ) then
    return;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'id'
  ) then
    execute '
      create table public.ai_usage (
        id uuid primary key default uuid_generate_v4(),
        user_id uuid not null references public.profiles(id),
        type text not null check (type in (''notes'', ''transcription'')),
        created_at timestamp not null default now()
      )
    ';
  elsif exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'user_id'
  ) then
    -- The current Luma app reads profiles by profiles.user_id, so this fallback
    -- keeps AI usage ownership aligned with the existing schema shape.
    execute '
      create table public.ai_usage (
        id uuid primary key default uuid_generate_v4(),
        user_id uuid not null references public.profiles(user_id),
        type text not null check (type in (''notes'', ''transcription'')),
        created_at timestamp not null default now()
      )
    ';
  else
    raise exception 'Could not create ai_usage table because public.profiles has neither id nor user_id.';
  end if;
end $$;

create index if not exists ai_usage_user_id_created_at_idx
  on public.ai_usage (user_id, created_at desc);

create index if not exists ai_usage_user_id_type_idx
  on public.ai_usage (user_id, type);
