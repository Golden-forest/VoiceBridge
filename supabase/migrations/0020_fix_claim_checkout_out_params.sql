-- Fix: Rename OUT parameter columns back to original names (id, status, etc.)
-- Using OUT parameters (instead of RETURNS TABLE) avoids the PL/pgSQL scope conflict
-- because OUT parameters are not exposed as column names in SQL statements.
-- This keeps the PostgREST response shape as {id, status, provider_transaction_id, checkout_url}
-- which matches what the Edge Function code expects.

drop function if exists public.claim_checkout_attempt(uuid, text);

create function public.claim_checkout_attempt(
  p_user_id uuid,
  p_provider text,
  out id uuid,
  out status text,
  out provider_transaction_id text,
  out checkout_url text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt record;
  v_creating_lease_seconds int := 30;
begin
  -- 查找该用户当前未完成的 attempt
  select * into v_attempt
  from public.billing_checkout_attempts bca
  where bca.user_id = p_user_id
    and bca.status in ('creating', 'open')
  order by bca.created_at desc
  limit 1
  for update;

  if not found then
    -- 没有现有 attempt，创建新的 creating attempt
    insert into public.billing_checkout_attempts (user_id, provider, status, expires_at)
    values (p_user_id, p_provider, 'creating', now() + interval '10 minutes')
    returning billing_checkout_attempts.id,
              billing_checkout_attempts.status,
              billing_checkout_attempts.provider_transaction_id,
              billing_checkout_attempts.checkout_url
    into v_attempt;
    id := v_attempt.id;
    status := v_attempt.status;
    provider_transaction_id := v_attempt.provider_transaction_id;
    checkout_url := v_attempt.checkout_url;
    return;
  end if;

  -- 如果是 creating 且已过期（lease），允许接管
  if v_attempt.status = 'creating' and v_attempt.updated_at < now() - (v_creating_lease_seconds || ' seconds')::interval then
    update public.billing_checkout_attempts
    set status = 'failed', last_error = 'lease expired', updated_at = now()
    where billing_checkout_attempts.id = v_attempt.id;

    insert into public.billing_checkout_attempts (user_id, provider, status, expires_at)
    values (p_user_id, p_provider, 'creating', now() + interval '10 minutes')
    returning billing_checkout_attempts.id,
              billing_checkout_attempts.status,
              billing_checkout_attempts.provider_transaction_id,
              billing_checkout_attempts.checkout_url
    into v_attempt;
    id := v_attempt.id;
    status := v_attempt.status;
    provider_transaction_id := v_attempt.provider_transaction_id;
    checkout_url := v_attempt.checkout_url;
    return;
  end if;

  -- 返回现有 attempt（调用方根据 status 决定行为）
  id := v_attempt.id;
  status := v_attempt.status;
  provider_transaction_id := v_attempt.provider_transaction_id;
  checkout_url := v_attempt.checkout_url;
  return;
end;
$$;

grant execute on function public.claim_checkout_attempt(uuid, text)
  to service_role;
revoke execute on function public.claim_checkout_attempt(uuid, text)
  from public, anon, authenticated;
