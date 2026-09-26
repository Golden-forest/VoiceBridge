-- Qualify every column that can collide with the function's output variables.
-- PostgreSQL exposes RETURNS TABLE names as PL/pgSQL variables, so an
-- unqualified `device_id` in the UPDATE below raises 42702 at runtime.
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
  device_owner_id uuid;
  device_paired_at timestamptz;
begin
  if p_user_id is null then
    return;
  end if;

  select pairing.device_id, device.user_id, device.paired_at
    into pairing_device_id, device_owner_id, device_paired_at
  from public.device_pairings as pairing
  join public.devices as device on device.id = pairing.device_id
  where pairing.token_hash = p_token_hash
    and pairing.claimed_at is null
    and pairing.expires_at > now()
    and device.status = 'active'
  for update of pairing;

  if pairing_device_id is null then
    return;
  end if;

  if device_paired_at is not null and device_owner_id <> p_user_id then
    return;
  end if;

  update public.device_pairings as pairing
  set claimed_at = now()
  where pairing.device_id = pairing_device_id
    and pairing.claimed_at is null;

  return query
  update public.devices as device
  set user_id = p_user_id,
      paired_at = coalesce(device.paired_at, now()),
      status = 'active',
      updated_at = now()
  where device.id = pairing_device_id
  returning device.id, device.name, device.platform;
end;
$$;

revoke all on function public.claim_device_pairing(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_device_pairing(text, uuid) to service_role;
