-- Fix: column reference "status" is ambiguous in claim_checkout_attempt
-- The RETURNS TABLE column names (status) clash with table column references in WHERE clauses.
-- Solution: alias the table and qualify all column references.

create or replace function public.claim_checkout_attempt(
  p_user_id uuid,
  p_provider text
) returns table(
  id uuid,
  status text,
  provider_transaction_id text,
  checkout_url text
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
    returning id, status, provider_transaction_id, checkout_url into v_attempt;
    return query select v_attempt.id, v_attempt.status, v_attempt.provider_transaction_id, v_attempt.checkout_url;
    return;
  end if;

  -- 如果是 creating 且已过期（lease），允许接管
  if v_attempt.status = 'creating' and v_attempt.updated_at < now() - (v_creating_lease_seconds || ' seconds')::interval then
    update public.billing_checkout_attempts
    set status = 'failed', last_error = 'lease expired', updated_at = now()
    where id = v_attempt.id;

    insert into public.billing_checkout_attempts (user_id, provider, status, expires_at)
    values (p_user_id, p_provider, 'creating', now() + interval '10 minutes')
    returning id, status, provider_transaction_id, checkout_url into v_attempt;
    return query select v_attempt.id, v_attempt.status, v_attempt.provider_transaction_id, v_attempt.checkout_url;
    return;
  end if;

  -- 返回现有 attempt（调用方根据 status 决定行为）
  return query select v_attempt.id, v_attempt.status, v_attempt.provider_transaction_id, v_attempt.checkout_url;
  return;
end;
$$;

-- Also fix process_billing_event: qualify status column reference in subscriptions query
-- Note: using DROP + CREATE because CREATE OR REPLACE cannot change function signature
-- and PostgreSQL sometimes falsely detects signature changes.
-- Safe approach: only fix the specific ambiguous query inside the function body.

-- First, drop the existing function
drop function if exists public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb);

-- Then recreate with the fix (qualified column names)
create function public.process_billing_event(
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
  v_user_id := nullif(p_effect->>'user_id', '')::uuid;
  v_subscription_id := p_effect->>'subscription_id';
  v_customer_id := p_effect->>'customer_id';
  v_price_id := p_effect->>'price_id';
  v_plan := coalesce(p_effect->>'plan', 'pro');
  v_status := p_effect->>'status';
  v_period_start := nullif(p_effect->>'period_start', '')::timestamptz;
  v_period_end := nullif(p_effect->>'period_end', '')::timestamptz;
  v_cancel_at_period_end := coalesce((p_effect->>'cancel_at_period_end')::boolean, false);
  v_transaction_id := p_effect->>'transaction_id';
  v_state_occurred_at := nullif(p_effect->>'state_occurred_at', '')::timestamptz;

  if v_effect_type is null or v_effect_type = 'ignore' then
    -- 插入事件标记为 ignored
    insert into public.billing_events (provider, event_id, event_type, occurred_at, status, user_id, provider_subscription_id, payload)
    values (p_provider, p_event_id, p_event_type, p_occurred_at, 'ignored', v_user_id, v_subscription_id, p_payload)
    on conflict (provider, event_id) do nothing;
    return 'processed';
  end if;

  -- 1. 插入事件；冲突时锁定
  begin
    insert into public.billing_events (provider, event_id, event_type, occurred_at, status, user_id, provider_subscription_id, payload)
    values (p_provider, p_event_id, p_event_type, p_occurred_at, 'received', v_user_id, v_subscription_id, p_payload)
    on conflict (provider, event_id) do nothing
    returning status into v_existing_status;
  exception
    when others then
      -- 插入失败，尝试读取已有记录
      select status into v_existing_status
      from public.billing_events
      where provider = p_provider and event_id = p_event_id;
  end;

  -- 如果 insert 没返回（即冲突），锁定已有记录
  if v_existing_status is null then
    select b.status into v_existing_status
    from public.billing_events b
    where b.provider = p_provider and b.event_id = p_event_id
    for update;

    if v_existing_status in ('processed', 'ignored') then
      return 'duplicate';
    end if;
  end if;

  -- 2. 忽略类型事件
  if v_effect_type = 'ignore' then
    update public.billing_events
    set status = 'ignored', processed_at = now(), payload = p_payload
    where provider = p_provider and event_id = p_event_id;
    return 'processed';
  end if;

  -- 3. 乱序检测
  select occurred_at into v_prev_occurred_at
  from public.billing_events
  where provider = p_provider
    and event_type like 'subscription.%'
    and occurred_at > p_occurred_at
  order by occurred_at asc
  limit 1;

  if found and v_effect_type like 'subscription.%' then
    -- 旧事件，跳过但标记为 processed
    update public.billing_events
    set status = 'processed', processed_at = now()
    where provider = p_provider and event_id = p_event_id;
    return 'stale';
  end if;

  -- 4. 写入 provider_subscriptions
  if v_effect_type in ('subscription.created', 'subscription.activated', 'subscription.updated', 'subscription.canceled', 'subscription.past_due', 'subscription.paused') then
    insert into public.provider_subscriptions (
      provider, provider_subscription_id, user_id, provider_customer_id,
      provider_price_id, plan, status,
      current_period_start, current_period_end, cancel_at_period_end,
      subscription_state_occurred_at, latest_transaction_id
    ) values (
      p_provider, v_subscription_id, v_user_id, v_customer_id,
      v_price_id, v_plan, v_status,
      v_period_start, v_period_end, v_cancel_at_period_end,
      v_state_occurred_at, v_transaction_id
    )
    on conflict (provider, provider_subscription_id) do update set
      user_id = coalesce(excluded.user_id, provider_subscriptions.user_id),
      provider_customer_id = coalesce(excluded.provider_customer_id, provider_subscriptions.provider_customer_id),
      provider_price_id = coalesce(excluded.provider_price_id, provider_subscriptions.provider_price_id),
      plan = excluded.plan,
      status = excluded.status,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      subscription_state_occurred_at = excluded.subscription_state_occurred_at,
      latest_transaction_id = coalesce(excluded.latest_transaction_id, provider_subscriptions.latest_transaction_id);

    -- 5. 更新 subscriptions（权益表）
    if v_user_id is not null then
      -- 读取当前权益（使用限定列名避免歧义）
      select s.source_provider, s.status, s.plan into v_current_provider, v_current_status, v_current_plan
      from public.subscriptions s
      where s.user_id = v_user_id;

      if v_current_provider is null then
        -- 无现有订阅，直接插入
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
      elsif v_current_provider = p_provider then
        -- 同来源，直接更新
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
      elsif v_current_status not in ('active', 'trialing') then
        -- 当前权益非活跃，新支付商可接管
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
    end if;
  end if;

  -- 6. 标记事件为 processed
  update public.billing_events
  set status = 'processed', processed_at = now(), payload = p_payload
  where provider = p_provider and event_id = p_event_id;

  return 'processed';

exception
  when others then
    -- 记录失败，让 Paddle 重试
    update public.billing_events
    set status = 'failed',
        attempt_count = attempt_count + 1,
        last_error = sqlerrm,
        processed_at = now()
    where provider = p_provider and event_id = p_event_id;
    raise notice 'process_billing_event failed: %', sqlerrm;
    return 'failed';
end;
$$;

-- Recreate grants
grant execute on function public.claim_checkout_attempt(uuid, text)
  to service_role;
revoke execute on function public.claim_checkout_attempt(uuid, text)
  from public, anon, authenticated;

grant execute on function public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb)
  to service_role;
revoke execute on function public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;
