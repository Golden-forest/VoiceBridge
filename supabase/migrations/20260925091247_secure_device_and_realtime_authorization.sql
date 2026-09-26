-- Restore tenant-scoped device and Realtime authorization after migration 0005
-- temporarily broadened both surfaces to every authenticated user.

-- Fail explicitly instead of waiting indefinitely if an active Realtime
-- transaction happens to hold a conflicting catalog lock during deployment.
set lock_timeout = '25s';
set statement_timeout = '45s';

revoke insert on public.devices from authenticated;
revoke update on public.devices from authenticated;

grant insert (
  id, user_id, runtime_user_id, name, device_type, platform, app_version,
  status, paired_at, last_seen_at, created_at, updated_at
) on public.devices to authenticated;

-- Ownership and pairing fields are service-role managed after insert. Clients
-- may only refresh presentation/liveness fields or revoke their visible row.
grant update (name, platform, app_version, status, last_seen_at, updated_at)
  on public.devices to authenticated;

grant delete on public.devices to authenticated;

drop policy if exists devices_insert_own on public.devices;
create policy devices_insert_own
  on public.devices
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and runtime_user_id = (select auth.uid())
    and paired_at is null
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

drop policy if exists devices_delete_own on public.devices;
create policy devices_delete_own
  on public.devices
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- Realtime policies need to authorize both the real account and the paired
-- anonymous desktop runtime. Keep the security-definer helper outside exposed
-- schemas so it can inspect the target device without weakening devices RLS.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.voicebridge_can_access_realtime(
  p_topic text,
  p_extension text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_extension = 'broadcast' then exists (
      select 1
      from public.devices as target
      where target.status = 'active'
        and p_topic = 'device:' || target.user_id || ':' || target.id
        and (
          target.user_id = (select auth.uid())
          or target.runtime_user_id = (select auth.uid())
          or exists (
            select 1
            from public.devices as actor
            where actor.runtime_user_id = (select auth.uid())
              and actor.user_id = target.user_id
              and actor.status = 'active'
              and actor.paired_at is not null
          )
        )
    )
    when p_extension = 'presence' then exists (
      select 1
      from public.devices as actor
      where actor.status = 'active'
        and p_topic = 'user:' || actor.user_id || ':presence'
        and (
          actor.user_id = (select auth.uid())
          or (
            actor.runtime_user_id = (select auth.uid())
            and actor.paired_at is not null
          )
        )
    )
    else false
  end;
$$;

revoke all on function private.voicebridge_can_access_realtime(text, text) from public, anon;
grant execute on function private.voicebridge_can_access_realtime(text, text) to authenticated;

drop policy if exists "realtime_own_device_broadcast_select" on realtime.messages;
drop policy if exists "realtime_linked_device_broadcast_select" on realtime.messages;
drop policy if exists "realtime_own_device_broadcast_insert" on realtime.messages;
drop policy if exists "realtime_linked_device_broadcast_insert" on realtime.messages;
drop policy if exists "realtime_own_presence_select" on realtime.messages;
drop policy if exists "realtime_linked_presence_select" on realtime.messages;
drop policy if exists "realtime_own_presence_insert" on realtime.messages;
drop policy if exists "realtime_linked_presence_insert" on realtime.messages;
drop policy if exists "rt_bc_sel" on realtime.messages;
drop policy if exists "rt_bc_ins" on realtime.messages;
drop policy if exists "rt_pr_sel" on realtime.messages;
drop policy if exists "rt_pr_ins" on realtime.messages;

create policy "voicebridge_broadcast_select"
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and (select private.voicebridge_can_access_realtime((select realtime.topic()), extension))
  );

create policy "voicebridge_broadcast_insert"
  on realtime.messages for insert to authenticated
  with check (
    extension = 'broadcast'
    and (select private.voicebridge_can_access_realtime((select realtime.topic()), extension))
  );

create policy "voicebridge_presence_select"
  on realtime.messages for select to authenticated
  using (
    extension = 'presence'
    and (select private.voicebridge_can_access_realtime((select realtime.topic()), extension))
  );

create policy "voicebridge_presence_insert"
  on realtime.messages for insert to authenticated
  with check (
    extension = 'presence'
    and (select private.voicebridge_can_access_realtime((select realtime.topic()), extension))
  );

-- Requests abandoned by a crashed client or an earlier signing failure must
-- not remain indefinitely in the active-processing state.
update public.usage_events
set
  status = 'failed',
  error_code = coalesce(error_code, 'stale_processing_cleanup')
where status = 'processing'
  and created_at < now() - interval '15 minutes';
