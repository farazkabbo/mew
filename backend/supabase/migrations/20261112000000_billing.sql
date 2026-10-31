-- Billing system: subscriptions, usage sessions, and Stripe webhook events.
--
-- Three new tables:
--   * subscriptions: Stripe subscription data per user
--   * usage_sessions: Free tier session tracking (5-hour limit with cooldown)
--   * stripe_events: Webhook event log for idempotency and debugging

-- ---------------------------------------------------------------------------------------------
-- subscriptions (Stripe subscription status)
-- ---------------------------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  stripe_customer_id text unique not null,
  stripe_subscription_id text unique,
  stripe_price_id text not null,
  status text not null check (status in ('active', 'canceled', 'past_due', 'incomplete', 'trialing')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  unique (id, user_id),
  -- Each user can only have one subscription
  unique (user_id)
);

create index subscriptions_user_id_idx on public.subscriptions (user_id);
create index subscriptions_stripe_customer_idx on public.subscriptions (stripe_customer_id);
create index subscriptions_stripe_subscription_idx on public.subscriptions (stripe_subscription_id);
create index subscriptions_status_idx on public.subscriptions (status);

create trigger subscriptions_touch_updated_at before update on public.subscriptions
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- usage_sessions (free tier 5-hour session tracking)
-- ---------------------------------------------------------------------------------------------
create table public.usage_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  seconds_used integer not null default 0 check (seconds_used >= 0 and seconds_used <= 18000),
  in_cooldown boolean not null default false,
  cooldown_started_at timestamptz,
  cooldown_ends_at timestamptz,
  session_started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  unique (user_id),
  -- Cooldown fields must both be set or both be null
  constraint usage_sessions_cooldown_consistent check (
    (in_cooldown = false and cooldown_started_at is null and cooldown_ends_at is null)
    or (in_cooldown = true and cooldown_started_at is not null and cooldown_ends_at is not null)
  )
);

create index usage_sessions_user_idx on public.usage_sessions (user_id);
create index usage_sessions_cooldown_idx on public.usage_sessions (in_cooldown, cooldown_ends_at);

create trigger usage_sessions_touch_updated_at before update on public.usage_sessions
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- stripe_events (webhook event log for idempotency)
-- ---------------------------------------------------------------------------------------------
create table public.stripe_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text unique not null,
  event_type text not null,
  processed boolean not null default false,
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 262144
  ),
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index stripe_events_type_processed_idx on public.stripe_events (event_type, processed);
create index stripe_events_stripe_id_idx on public.stripe_events (stripe_event_id);
create index stripe_events_created_idx on public.stripe_events (created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Privileges: subscriptions and usage_sessions are user-readable; stripe_events is admin-only
-- ---------------------------------------------------------------------------------------------
revoke all on public.subscriptions, public.usage_sessions, public.stripe_events from anon, authenticated;

grant select on public.subscriptions to authenticated;
grant select on public.usage_sessions to authenticated;
-- stripe_events: no grants (admin only)

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------
alter table public.subscriptions enable row level security;
alter table public.usage_sessions enable row level security;
alter table public.stripe_events enable row level security;

-- subscriptions: users can only see their own
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- usage_sessions: users can only see their own
create policy usage_sessions_select on public.usage_sessions for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- stripe_events: no user access (webhook handler uses service role)

-- ---------------------------------------------------------------------------------------------
-- Helper function: check if user is premium (has active subscription)
-- ---------------------------------------------------------------------------------------------
create function public.is_premium_user(user_id_param text)
returns boolean
language sql
stable
security definer
as $$
  select exists(
    select 1 from public.subscriptions
    where user_id = user_id_param
      and status in ('active', 'trialing')
      and current_period_end > now()
  );
$$;

-- Grant execute to authenticated users
grant execute on function public.is_premium_user(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helper function: get or create usage session for user
-- ---------------------------------------------------------------------------------------------
create function public.get_or_create_usage_session(user_id_param text)
returns public.usage_sessions
language plpgsql
security definer
as $$
declare
  session public.usage_sessions;
begin
  -- Try to get existing session
  select * into session
  from public.usage_sessions
  where user_id = user_id_param;
  
  -- If no session exists, create one
  if not found then
    insert into public.usage_sessions (user_id)
    values (user_id_param)
    returning * into session;
  end if;
  
  return session;
end;
$$;

-- Grant execute to authenticated users
grant execute on function public.get_or_create_usage_session(text) to authenticated;

