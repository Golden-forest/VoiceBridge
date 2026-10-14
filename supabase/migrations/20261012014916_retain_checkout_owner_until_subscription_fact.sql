-- A completed payment may arrive before subscription.created. Preserve the
-- checkout owner until the corresponding subscription fact is established,
-- so account deletion can still cancel every remotely billable subscription.
alter table public.billing_checkout_attempts add column provider_subscription_id text;

-- Backfill trusted associations recorded by older signature-verified events.
update public.billing_checkout_attempts a
set provider_subscription_id = ps.provider_subscription_id
from public.provider_subscriptions ps
where a.provider = 'paddle' and ps.provider = a.provider
  and ps.user_id = a.user_id and ps.latest_transaction_id = a.provider_transaction_id;
update public.billing_checkout_attempts a
set provider_subscription_id = be.provider_subscription_id
from public.billing_events be
where a.provider = 'paddle' and a.provider_subscription_id is null
  and be.provider = a.provider and be.user_id = a.user_id
  and be.status = 'processed' and be.event_type = 'transaction.completed'
  and be.provider_subscription_id is not null
  and be.payload #>> '{data,id}' = a.provider_transaction_id;

create or replace function public.begin_account_deletion(p_user_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_user_id::text, 0));
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
  -- allowed, but buying again requires explicit support reconciliation.
  return 'account_deleting';
end;
$$;

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

create or replace function public.process_billing_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_effect jsonb
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_status text;
  v_effect_type text;
  v_user_id_text text;
  v_user_id uuid;
  v_subscription_id text;
  v_customer_id text;
  v_price_id text;
  v_plan text;
  v_status text;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_cancel_at_period_end boolean;
  v_transaction_id text;
  v_state_occurred_at timestamptz;
  v_current_provider text;
  v_current_status text;
  v_current_plan text;
  v_prev_occurred_at timestamptz;
begin
  v_effect_type := p_effect->>'type';
  v_user_id_text := nullif(p_effect->>'user_id', '');
  if v_user_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_user_id := v_user_id_text::uuid;
  end if;
  v_subscription_id := nullif(p_effect->>'subscription_id', '');
  v_customer_id := nullif(p_effect->>'customer_id', '');
  v_price_id := nullif(p_effect->>'price_id', '');
  v_plan := coalesce(nullif(p_effect->>'plan', ''), 'pro');
  v_status := nullif(p_effect->>'status', '');
  v_period_start := nullif(p_effect->>'period_start', '')::timestamptz;
  v_period_end := nullif(p_effect->>'period_end', '')::timestamptz;
  v_cancel_at_period_end := coalesce((p_effect->>'cancel_at_period_end')::boolean, false);
  v_transaction_id := nullif(p_effect->>'transaction_id', '');
  v_state_occurred_at := coalesce(
    nullif(p_effect->>'state_occurred_at', '')::timestamptz,
    p_occurred_at
  );

  -- Claim the event. Failed/received events are retryable; completed events are
  -- idempotent duplicates.
  insert into public.billing_events (
    provider, event_id, event_type, occurred_at, status, user_id,
    provider_subscription_id, payload
  ) values (
    p_provider, p_event_id, p_event_type, p_occurred_at, 'received', v_user_id,
    v_subscription_id, p_payload
  )
  on conflict (provider, event_id) do nothing
  returning billing_events.status into v_existing_status;

  if v_existing_status is null then
    select be.status into v_existing_status
    from public.billing_events be
    where be.provider = p_provider and be.event_id = p_event_id
    for update;

    if v_existing_status in ('processed', 'ignored') then
      return 'duplicate';
    end if;
  end if;

  if v_effect_type is null or v_effect_type = 'ignore' then
    update public.billing_events
    set status = 'ignored', processed_at = now(), payload = p_payload,
        last_error = null
    where provider = p_provider and event_id = p_event_id;
    return 'processed';
  end if;

  if v_effect_type not in ('subscription', 'transaction') then
    raise exception 'Unsupported billing effect type: %', v_effect_type;
  end if;

  -- Establish the customer mapping before inserting a subscription protected by
  -- the composite foreign key.
  if v_user_id is not null and v_customer_id is not null then
    insert into public.billing_customers (user_id, provider, provider_customer_id)
    values (v_user_id, p_provider, v_customer_id)
    on conflict (user_id, provider) do update set
      provider_customer_id = excluded.provider_customer_id,
      updated_at = now();
  end if;

  if v_effect_type = 'subscription' then
    if v_user_id is null or v_customer_id is null or v_subscription_id is null or v_status is null then
      raise exception 'Subscription effect is missing user, customer, subscription, or status';
    end if;

    select ps.subscription_state_occurred_at into v_prev_occurred_at
    from public.provider_subscriptions ps
    where ps.provider = p_provider
      and ps.provider_subscription_id = v_subscription_id
    for update;

    if v_prev_occurred_at is not null and v_state_occurred_at < v_prev_occurred_at then
      update public.billing_events
      set status = 'processed', processed_at = now(), payload = p_payload,
          user_id = v_user_id, provider_subscription_id = v_subscription_id,
          last_error = null
      where provider = p_provider and event_id = p_event_id;
      return 'stale';
    end if;

    insert into public.provider_subscriptions (
      provider, provider_subscription_id, user_id, provider_customer_id,
      provider_price_id, plan, status, current_period_start,
      current_period_end, cancel_at_period_end,
      subscription_state_occurred_at, latest_transaction_id
    ) values (
      p_provider, v_subscription_id, v_user_id, v_customer_id,
      v_price_id, v_plan, v_status, v_period_start,
      v_period_end, v_cancel_at_period_end,
      v_state_occurred_at, v_transaction_id
    )
    on conflict (provider, provider_subscription_id) do update set
      user_id = excluded.user_id,
      provider_customer_id = excluded.provider_customer_id,
      provider_price_id = coalesce(excluded.provider_price_id, provider_subscriptions.provider_price_id),
      plan = excluded.plan,
      status = excluded.status,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      subscription_state_occurred_at = excluded.subscription_state_occurred_at,
      latest_transaction_id = coalesce(excluded.latest_transaction_id, provider_subscriptions.latest_transaction_id),
      updated_at = now();

    select s.source_provider, s.status, s.plan
      into v_current_provider, v_current_status, v_current_plan
    from public.subscriptions s
    where s.user_id = v_user_id
    for update;

    if v_current_plan is distinct from 'admin'
       and (
         v_current_provider is null
         or v_current_provider = p_provider
         or v_current_status not in ('active', 'trialing')
       ) then
      insert into public.subscriptions (
        user_id, source_provider, source_subscription_id, plan, status,
        current_period_start, current_period_end, cancel_at_period_end,
        entitlement_updated_at, updated_at
      ) values (
        v_user_id, p_provider, v_subscription_id, v_plan, v_status,
        v_period_start, v_period_end, v_cancel_at_period_end,
        v_state_occurred_at, now()
      )
      on conflict (user_id) do update set
        source_provider = excluded.source_provider,
        source_subscription_id = excluded.source_subscription_id,
        plan = excluded.plan,
        status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        entitlement_updated_at = excluded.entitlement_updated_at,
        updated_at = now();
    end if;

    if v_transaction_id is not null then
      update public.billing_checkout_attempts
      set status = 'completed', provider_subscription_id = v_subscription_id,
          updated_at = now(), last_error = null
      where provider = p_provider
        and provider_transaction_id = v_transaction_id
        and status in ('creating', 'open');
    end if;
  end if;

  if v_effect_type = 'transaction' then
    if v_subscription_id is not null and v_transaction_id is not null then
      update public.provider_subscriptions
      set latest_transaction_id = v_transaction_id, updated_at = now()
      where provider = p_provider
        and provider_subscription_id = v_subscription_id;
    end if;

    if p_event_type = 'transaction.completed' and v_transaction_id is not null then
      update public.billing_checkout_attempts
      set status = 'completed', provider_subscription_id = v_subscription_id,
          updated_at = now(), last_error = null
      where provider = p_provider
        and provider_transaction_id = v_transaction_id
        and status in ('creating', 'open');
    end if;
  end if;

  update public.billing_events
  set status = 'processed', processed_at = now(), payload = p_payload,
      user_id = coalesce(v_user_id, user_id),
      provider_subscription_id = coalesce(v_subscription_id, provider_subscription_id),
      last_error = null
  where provider = p_provider and event_id = p_event_id;

  return 'processed';
exception
  when others then
    update public.billing_events
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error = sqlerrm, processed_at = now(), payload = p_payload
    where provider = p_provider and event_id = p_event_id;
    return 'failed';
end;
$$;

revoke all on function public.begin_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid) to service_role;
revoke all on function public.process_billing_event(text,text,text,timestamptz,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.process_billing_event(text,text,text,timestamptz,jsonb,jsonb) to service_role;

revoke all on function public.claim_checkout_attempt(uuid,text) from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(uuid,text) to service_role;
