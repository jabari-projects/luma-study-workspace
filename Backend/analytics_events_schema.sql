create table if not exists public.analytics_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(user_id) on delete set null,
  event_name text not null,
  event_group text not null,
  page_path text,
  feature_key text,
  subscription_tier text,
  surface text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_user_created_at_idx
  on public.analytics_events (user_id, created_at desc);

create index if not exists analytics_events_event_name_idx
  on public.analytics_events (event_name, created_at desc);

create index if not exists analytics_events_event_group_idx
  on public.analytics_events (event_group, created_at desc);
