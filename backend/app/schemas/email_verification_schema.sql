-- Luma email verification schema for the existing Supabase-backed FastAPI app.
-- Apply this in Supabase SQL editor or your preferred deployment flow.
--
-- email_verification_token and email_verification_sent_at are unused since
-- link verification was removed (codes live in email_codes now). Old hashed
-- tokens stay here until an owner-approved migration nulls and drops them.

alter table if exists public.users
    add column if not exists email_verified boolean not null default false,
    add column if not exists email_verification_token text,
    add column if not exists email_verification_sent_at timestamptz;

create unique index if not exists users_email_verification_token_idx
    on public.users (email_verification_token)
    where email_verification_token is not null;
