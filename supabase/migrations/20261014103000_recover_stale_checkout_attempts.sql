-- An ambiguous provider failure (timeout/5xx before any transaction id was
-- recorded) used to leave the attempt in 'creating' forever: claim requires
-- provider_request_started_at IS NULL, webhooks settle by transaction id and
-- expires_at was never consulted. Retire such attempts after a bounded window
-- so purchases and deletion proceed. The user never received a checkout URL
-- for a timed-out creation, so retiring exposes nothing payable; a late
-- webhook that does arrive still establishes its own subscription facts.
create function public.sweep_stale_checkout_attempts(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_retired int;
begin
  update public.billing_checkout_attempts
  set status = 'expired', updated_at = now(), last_error = 'provider_request_stale'
  where user_id = p_user_id
    and status = 'creating'
    and provider_request_started_at < now() - interval '15 minutes';
  get diagnostics v_retired = row_count;
  return v_retired;
end;
$$;
revoke all on function public.sweep_stale_checkout_attempts(uuid) from public, anon, authenticated;
grant execute on function public.sweep_stale_checkout_attempts(uuid) to service_role;

create or replace function public.begin_account_deletion(p_user_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_user_id::text, 0));
  perform public.sweep_stale_checkout_attempts(p_user_id);
  if exists (select 1 from public.profiles where user_id = p_user_id and is_admin) then
    return 'admin_protected';
  end if;
  if exists (
    select 1 from public.billing_checkout_attempts
    where user_id = p_user_id and (
      status in ('creating', 'open')
      or (provider = 'paddle' and status = 'completed' and (
        provider_subscription_id is null
        or not exists (
          select 1 from public.provider_subscriptions ps
          where ps.provider = billing_checkout_attempts.provider
            and ps.provider_subscription_id = billing_checkout_attempts.provider_subscription_id
            and ps.user_id = p_user_id
        )
      ))
    )
  ) then
    return 'checkout_pending';
  end if;
  update public.profiles
  set account_deletion_requested_at = coalesce(account_deletion_requested_at, now())
  where user_id = p_user_id;
  if not found then return 'account_not_found'; end if;
  -- Retain intent after provider cancellation failure. Delete retries are
  -- allowed; a cancellation failure releases the intent via
  -- clear_account_deletion_request so purchases remain possible.
  return 'account_deleting';
end;
$$;
revoke all on function public.begin_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid) to service_role;

create or replace function public.claim_checkout_attempt(p_user_id uuid, p_provider text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_attempt public.billing_checkout_attempts%rowtype;
  v_acquired boolean := false;
begin
  if p_provider not in ('stripe', 'paddle') then raise exception 'Unsupported billing provider'; end if;
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_user_id::text, 0));
  perform public.sweep_stale_checkout_attempts(p_user_id);
  if exists (
    select 1 from public.profiles where user_id = p_user_id
      and account_deletion_requested_at is not null
  ) then
    return jsonb_build_object('status', 'account_deleting', 'acquired', false);
  end if;
  -- Payment completion alone does not prove that a subscription fact and
  -- its entitlement have arrived. Fence repeat purchases during that gap.
  if exists (
    select 1 from public.billing_checkout_attempts a
    where a.user_id = p_user_id and a.provider = 'paddle' and a.status = 'completed'
      and (a.provider_subscription_id is null or not exists (
        select 1 from public.provider_subscriptions ps
        where ps.provider = a.provider
          and ps.provider_subscription_id = a.provider_subscription_id
          and ps.user_id = p_user_id
      ))
  ) then
    return jsonb_build_object('status', 'subscription_pending', 'acquired', false);
  end if;
  if exists (
    select 1 from public.subscriptions s where s.user_id = p_user_id
      and (s.plan = 'admin' or (s.plan = 'pro' and s.status in ('active', 'trialing', 'past_due')))
  ) then
    return jsonb_build_object('status', 'entitlement_exists', 'acquired', false);
  end if;
  select * into v_attempt from public.billing_checkout_attempts a
  where a.user_id = p_user_id and a.status in ('creating', 'open')
  order by a.created_at desc limit 1 for update;
  if not found then
    insert into public.billing_checkout_attempts(user_id, provider, status, expires_at, lease_token)
    values(p_user_id, p_provider, 'creating', now() + interval '10 minutes', gen_random_uuid())
    returning * into v_attempt;
    v_acquired := true;
  elsif v_attempt.provider = p_provider and v_attempt.status = 'creating'
     and v_attempt.provider_request_started_at is null
     and v_attempt.updated_at < now() - interval '30 seconds' then
    update public.billing_checkout_attempts
    set lease_token = gen_random_uuid(), updated_at = now(), last_error = null
    where id = v_attempt.id returning * into v_attempt;
    v_acquired := true;
  end if;
  return jsonb_build_object(
    'id', v_attempt.id, 'status', v_attempt.status, 'provider', v_attempt.provider,
    'acquired', v_acquired,
    'lease_token', case when v_acquired then v_attempt.lease_token else null end,
    'provider_transaction_id', v_attempt.provider_transaction_id,
    'checkout_url', v_attempt.checkout_url
  );
end;
$$;
revoke all on function public.claim_checkout_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(uuid, text) to service_role;
