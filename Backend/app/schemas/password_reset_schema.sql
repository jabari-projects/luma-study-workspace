-- Luma password reset schema for the existing Supabase-backed FastAPI app.
-- Apply this in Supabase SQL editor or your preferred deployment flow.

alter table if exists public.users
    add column if not exists password_reset_token text,
    add column if not exists password_reset_sent_at timestamptz;

create unique index if not exists users_password_reset_token_idx
    on public.users (password_reset_token)
    where password_reset_token is not null;
