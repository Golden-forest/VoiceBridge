alter table public.devices
  add column if not exists runtime_user_id uuid references auth.users(id) on delete cascade;

alter table public.devices
  add column if not exists paired_at timestamptz;

update public.devices
set runtime_user_id = user_id
where runtime_user_id is null;

alter table public.devices
  alter column runtime_user_id set default auth.uid(),
  alter column runtime_user_id set not null;

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

drop policy if exists devices_select_own on public.devices;
drop policy if exists devices_select_linked on public.devices;
create policy devices_select_linked
  on public.devices
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or runtime_user_id = (select auth.uid())
  );

drop policy if exists devices_insert_own on public.devices;
create policy devices_insert_own
  on public.devices
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and runtime_user_id = (select auth.uid())
  );

drop policy if exists devices_update_own on public.devices;
drop policy if exists devices_update_linked on public.devices;
create policy devices_update_linked
  on public.devices
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    or runtime_user_id = (select auth.uid())
  )
  with check (
    user_id = (select auth.uid())
    or runtime_user_id = (select auth.uid())
  );

drop policy if exists "realtime_own_device_broadcast_select" on realtime.messages;
drop policy if exists "realtime_linked_device_broadcast_select" on realtime.messages;
create policy "realtime_linked_device_broadcast_select"
  on realtime.messages
  for select
  to authenticated
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
  on realtime.messages
  for insert
  to authenticated
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
  on realtime.messages
  for select
  to authenticated
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
  on realtime.messages
  for insert
  to authenticated
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
