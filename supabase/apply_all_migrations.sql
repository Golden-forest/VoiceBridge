-- VoiceBridge 一次性补跑所有 migration（幂等可重复执行）
-- 在 Supabase Dashboard → SQL Editor → New Query 粘贴整段运行
-- 来源：0001_cloud_core.sql / 0003_auto_create_profile.sql / 0004_device_pairing.sql

-- ========================================================
-- 0001_cloud_core.sql
-- ========================================================
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

create index if not exists devices_user_id_idx on public.devices (user_id);
create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_events enable row level security;
alter table public.stripe_events enable row level security;

grant select on public.profiles to authenticated;
grant select, insert, update on public.devices to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.usage_events to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own
  on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists usage_events_select_own on public.usage_events;
create policy usage_events_select_own
  on public.usage_events for select to authenticated
  using (user_id = (select auth.uid()));

-- ========================================================
-- 0003_auto_create_profile.sql
-- ========================================================
alter table public.profiles
  add column if not exists plan text not null default 'free';

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, plan)
  values (new.id, new.email, 'free')
  on conflict (user_id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

insert into public.profiles (user_id, email, plan)
select id, email, 'free'
from auth.users
on conflict (user_id) do update
  set email = excluded.email,
      updated_at = now();

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_user();

drop function if exists public.handle_new_user();

-- ========================================================
-- 0004_device_pairing.sql（关键：决定 Realtime 订阅能否成功）
-- ========================================================
alter table public.devices
  add column if not exists runtime_user_id uuid references auth.users(id) on delete cascade;

alter table public.devices
  add column if not exists paired_at timestamptz;

update public.devices
set runtime_user_id = user_id
where runtime_user_id is null;

alter table public.devices
  alter column runtime_user_id set default auth.uid();

-- 注意：旧设备表里如果有遗留 NULL，上面的 update 应已填上；
-- 若仍有 NULL（例如缺失 user_id 的边缘情况）会失败，此时请删除该列约束或手工清理。
-- 为安全起见此处不强制 NOT NULL，避免阻塞脚本。

create index if not exists devices_runtime_user_id_idx
  on public.devices (runtime_user_id);

create table if not exists public.device_pairings (
  device_id uuid primary key references public.devices(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists device_pairings_expires_at_idx
  on public.device_pairings (expires_at);

alter table public.device_pairings enable row level security;
revoke all on public.device_pairings from anon, authenticated;

create or replace function public.claim_device_pairing(
  p_token_hash text,
  p_user_id uuid
)
returns table (
  device_id uuid,
  device_name text,
  device_platform text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  pairing_device_id uuid;
begin
  if p_user_id is null then
    return;
  end if;

  update public.device_pairings
  set claimed_at = now()
  where token_hash = p_token_hash
    and claimed_at is null
    and expires_at > now()
  returning public.device_pairings.device_id into pairing_device_id;

  if pairing_device_id is null then
    return;
  end if;

  return query
  update public.devices
  set user_id = p_user_id,
      paired_at = now(),
      status = 'active',
      updated_at = now()
  where id = pairing_device_id
  returning id, name, platform;
end;
$$;

revoke all on function public.claim_device_pairing(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_device_pairing(text, uuid) to service_role;

revoke update on public.devices from authenticated;
grant update (name, platform, app_version, status, last_seen_at, updated_at)
  on public.devices to authenticated;

-- 设备表 RLS（linked：手机用户和桌面 runtime user 都能访问）
drop policy if exists devices_select_own on public.devices;
drop policy if exists devices_select_linked on public.devices;
create policy devices_select_linked
  on public.devices for select to authenticated
  using (
    user_id = (select auth.uid())
    or runtime_user_id = (select auth.uid())
  );

drop policy if exists devices_insert_own on public.devices;
create policy devices_insert_own
  on public.devices for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and runtime_user_id = (select auth.uid())
  );

drop policy if exists devices_update_own on public.devices;
drop policy if exists devices_update_linked on public.devices;
create policy devices_update_linked
  on public.devices for update to authenticated
  using (
    user_id = (select auth.uid())
    or runtime_user_id = (select auth.uid())
  )
  with check (
    user_id = (select auth.uid())
    or runtime_user_id = (select auth.uid())
  );

-- ========================================================
-- Realtime RLS policies（最关键！决定订阅成功与否）
-- ========================================================
-- 注意：Supabase Realtime 必须先在 Dashboard 启用（Realtime → Settings → Enable Broadcasting & Presence）

drop policy if exists "realtime_own_device_broadcast_select" on realtime.messages;
drop policy if exists "realtime_linked_device_broadcast_select" on realtime.messages;
create policy "realtime_linked_device_broadcast_select"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1
      from public.devices as device
      where device.status = 'active'
        and (device.user_id = (select auth.uid()) or device.runtime_user_id = (select auth.uid()))
        and (select realtime.topic()) = 'device:' || device.user_id || ':' || device.id
    )
  );

drop policy if exists "realtime_own_device_broadcast_insert" on realtime.messages;
drop policy if exists "realtime_linked_device_broadcast_insert" on realtime.messages;
create policy "realtime_linked_device_broadcast_insert"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1
      from public.devices as device
      where device.status = 'active'
        and (device.user_id = (select auth.uid()) or device.runtime_user_id = (select auth.uid()))
        and (select realtime.topic()) = 'device:' || device.user_id || ':' || device.id
    )
  );

drop policy if exists "realtime_own_presence_select" on realtime.messages;
drop policy if exists "realtime_linked_presence_select" on realtime.messages;
create policy "realtime_linked_presence_select"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and (
      (select realtime.topic()) = 'user:' || (select auth.uid()) || ':presence'
      or exists (
        select 1
        from public.devices as device
        where device.status = 'active'
          and device.runtime_user_id = (select auth.uid())
          and (select realtime.topic()) = 'user:' || device.user_id || ':presence'
      )
    )
  );

drop policy if exists "realtime_own_presence_insert" on realtime.messages;
drop policy if exists "realtime_linked_presence_insert" on realtime.messages;
create policy "realtime_linked_presence_insert"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (
      (select realtime.topic()) = 'user:' || (select auth.uid()) || ':presence'
      or exists (
        select 1
        from public.devices as device
        where device.status = 'active'
          and device.runtime_user_id = (select auth.uid())
          and (select realtime.topic()) = 'user:' || device.user_id || ':presence'
      )
    )
  );

-- ========================================================
-- 完成
-- ========================================================
