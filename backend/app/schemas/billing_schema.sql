-- Verified Stripe ids linked to Luma accounts (see app/billing.py).
--
-- Ownership of a Stripe customer or subscription comes only from these rows,
-- written by the webhook after it re-reads the Checkout Session from Stripe.
-- It is never inferred from an email address.
--
-- LEGACY SUBSCRIPTIONS ARE NOT BACKFILLED. Subscriptions created before this
-- table existed have no row here. Do not guess an owner by email or name: an
-- owner must check the subscription in the Stripe dashboard (Checkout Session
-- client_reference_id / metadata.user_id) and then insert the rows by hand.
-- Until then, account deletion for a Premium account without a link stops as
-- "billing_needs_review" and keeps the account.
--
-- Safe to re-run.

create table if not exists public.billing_accounts (
  user_id uuid primary key references public.users(id) on delete cascade,
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  stripe_customer_id text not null,
  status text not null,
  current_period_end timestamptz null,
  updated_at timestamptz not null default now()
);

create index if not exists billing_subscriptions_user_id_idx
  on public.billing_subscriptions (user_id);

-- Only the backend (service role) reads or writes billing links.
alter table public.billing_accounts enable row level security;
alter table public.billing_subscriptions enable row level security;
