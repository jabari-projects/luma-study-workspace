-- Luma notifications schema for the existing Supabase-backed FastAPI app.
-- Apply this in Supabase SQL editor or your preferred deployment flow.

create table if not exists public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    type text not null,
    actor_user_id uuid references public.users (id) on delete set null,
    created_at timestamptz not null default timezone('utc', now()),
    read boolean not null default false,
    payload jsonb,
    constraint notifications_type_check check (type in ('system'))
);

create index if not exists notifications_user_id_idx on public.notifications (user_id);
create index if not exists notifications_user_created_at_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_actor_user_id_idx on public.notifications (actor_user_id);
create index if not exists notifications_user_read_idx on public.notifications (user_id, read);
