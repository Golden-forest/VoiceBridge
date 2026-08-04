-- Fix the contract between paddle-webhook and process_billing_event.
--
-- The Edge Function emits effect.type as one of:
--   subscription | transaction | ignore
-- while migrations 0018/0019 accidentally changed the RPC to compare that
-- value with Paddle event names such as subscription.created. Valid events
-- were therefore marked processed without updating billing facts/entitlements.

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
      set status = 'completed', updated_at = now(), last_error = null
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
      set status = 'completed', updated_at = now(), last_error = null
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

grant execute on function public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb)
  to service_role;
revoke execute on function public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;

-- Replay only previously signature-verified Paddle events that the broken RPC
-- marked processed. Ignored/failed events and other providers are untouched.
do $$
declare
  v_event record;
  v_effect jsonb;
  v_status text;
begin
  for v_event in
    select provider, event_id, event_type, occurred_at, payload
    from public.billing_events
    where provider = 'paddle'
      and status = 'processed'
      and (event_type like 'subscription.%' or event_type = 'transaction.completed')
    order by occurred_at, event_id
  loop
    if v_event.event_type like 'subscription.%' then
      v_status := case v_event.payload#>>'{data,status}'
        when 'active' then 'active'
        when 'trialing' then 'trialing'
        when 'paused' then 'paused'
        when 'past_due' then 'past_due'
        when 'canceled' then 'canceled'
        else v_event.payload#>>'{data,status}'
      end;

      v_effect := jsonb_strip_nulls(jsonb_build_object(
        'type', 'subscription',
        'user_id', v_event.payload#>>'{data,custom_data,user_id}',
        'customer_id', v_event.payload#>>'{data,customer_id}',
        'subscription_id', v_event.payload#>>'{data,id}',
        'price_id', v_event.payload#>>'{data,items,0,price,id}',
        'plan', 'pro',
        'status', v_status,
        'period_start', v_event.payload#>>'{data,current_billing_period,starts_at}',
        'period_end', v_event.payload#>>'{data,current_billing_period,ends_at}',
        'cancel_at_period_end', coalesce(v_event.payload#>>'{data,scheduled_change,action}' = 'cancel', false),
        'state_occurred_at', v_event.occurred_at,
        'transaction_id', v_event.payload#>>'{data,transaction_id}'
      ));
    else
      v_effect := jsonb_strip_nulls(jsonb_build_object(
        'type', 'transaction',
        'user_id', v_event.payload#>>'{data,custom_data,user_id}',
        'customer_id', v_event.payload#>>'{data,customer_id}',
        'subscription_id', v_event.payload#>>'{data,subscription_id}',
        'transaction_id', v_event.payload#>>'{data,id}'
      ));
    end if;

    update public.billing_events
    set status = 'received', processed_at = null, last_error = null
    where provider = v_event.provider and event_id = v_event.event_id;

    perform public.process_billing_event(
      v_event.provider,
      v_event.event_id,
      v_event.event_type,
      v_event.occurred_at,
      v_event.payload,
      v_effect
    );
  end loop;
end;
$$;
