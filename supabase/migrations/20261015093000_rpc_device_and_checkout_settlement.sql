-- Device-ownership authorization and Stripe checkout settlement move behind
-- RPCs so the SQL regression suite can exercise them. Edge Functions do not
-- query business tables directly (repository convention: logic in RPCs under
-- RLS and idempotency guarantees).
create function public.resolve_transcribe_device(p_device_id uuid, p_runtime_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid;
  v_paired_at timestamptz;
begin
  select user_id, paired_at into v_user_id, v_paired_at
  from public.devices
  where id = p_device_id
    and runtime_user_id = p_runtime_user_id
    and status = 'active'
  limit 1;
  if v_user_id is null or v_paired_at is null then
    return jsonb_build_object('paired', false);
  end if;
  return jsonb_build_object('paired', true, 'user_id', v_user_id);
end;
$$;
revoke all on function public.resolve_transcribe_device(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_transcribe_device(uuid, uuid) to service_role;

create function public.settle_stripe_checkout_attempt(p_provider_transaction_id text, p_status text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_settled int;
begin
  if p_status not in ('completed', 'expired') then
    raise exception 'Invalid checkout settlement status';
  end if;
  update public.billing_checkout_attempts
  set status = p_status, updated_at = now(), last_error = null
  where provider = 'stripe'
    and provider_transaction_id = p_provider_transaction_id
    and status in ('creating', 'open');
  get diagnostics v_settled = row_count;
  return v_settled;
end;
$$;
revoke all on function public.settle_stripe_checkout_attempt(text, text) from public, anon, authenticated;
grant execute on function public.settle_stripe_checkout_attempt(text, text) to service_role;
