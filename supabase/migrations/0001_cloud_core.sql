create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  device_type text not null check (device_type in ('phone', 'desktop')),
  platform text not null,
  app_version text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text unique,
  stripe_price_id text,
  plan text not null default 'free',
  status text not null default 'free',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  provider text not null,
  mode text not null default 'cloud',
  audio_duration_ms int,
  audio_size_bytes int,
  status text not null check (status in ('success', 'failed', 'rejected')),
  error_code text,
  cost_estimated numeric(10, 6),
  created_at timestamptz not null default now()
);

create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_events enable row level security;
alter table public.stripe_events enable row level security;

grant select on public.profiles to authenticated;
grant select, insert, update on public.devices to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.usage_events to authenticated;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (user_id = auth.uid());

create policy devices_select_own
  on public.devices
  for select
  to authenticated
  using (user_id = auth.uid());

create policy devices_insert_own
  on public.devices
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy devices_update_own
  on public.devices
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy subscriptions_select_own
  on public.subscriptions
  for select
  to authenticated
  using (user_id = auth.uid());

create policy usage_events_select_own
  on public.usage_events
  for select
  to authenticated
  using (user_id = auth.uid());

create policy realtime_own_device_broadcast_select
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and topic like 'device:' || auth.uid() || ':%'
  );

create policy realtime_own_device_broadcast_insert
  on realtime.messages
  for insert
  to authenticated
  with check (
    extension = 'broadcast'
    and topic like 'device:' || auth.uid() || ':%'
  );

create policy realtime_own_presence_select
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'presence'
    and topic = 'user:' || auth.uid() || ':presence'
  );

create policy realtime_own_presence_insert
  on realtime.messages
  for insert
  to authenticated
  with check (
    extension = 'presence'
    and topic = 'user:' || auth.uid() || ':presence'
  );
