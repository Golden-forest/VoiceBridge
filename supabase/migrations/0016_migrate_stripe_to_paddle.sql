-- Stripe → Paddle 支付迁移
-- 设计文档：docs/superpowers/specs/2026-08-02-stripe-to-paddle-migration-design.md
--
-- 本迁移只做"扩展"：新增支付商无关的表和字段，不删除任何 Stripe 列或表。
-- Stripe Webhook 将在本迁移后改为双写新表（见 stripe-webhook Edge Function 更新）。

-- ============================================================================
-- 1. Customer 映射表（每个支付商的 Customer ID → user_id）
-- ============================================================================
create table if not exists public.billing_customers (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null
    check (provider in ('stripe', 'paddle', 'apple', 'google')),
  provider_customer_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  unique (provider, provider_customer_id),
  unique (user_id, provider, provider_customer_id)
);

alter table public.billing_customers enable row level security;

-- ============================================================================
-- 2. 支付商订阅事实表（各支付商的订阅记录与状态历史）
-- ============================================================================
create table if not exists public.provider_subscriptions (
  provider text not null
    check (provider in ('stripe', 'paddle', 'apple', 'google')),
  provider_subscription_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_customer_id text not null,
  provider_price_id text,
  plan text not null default 'pro',
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  subscription_state_occurred_at timestamptz,
  latest_transaction_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, provider_subscription_id),
  foreign key (user_id, provider, provider_customer_id)
    references public.billing_customers(user_id, provider, provider_customer_id)
);

alter table public.provider_subscriptions enable row level security;

-- ============================================================================
-- 3. Checkout 并发控制表
-- ============================================================================
create table if not exists public.billing_checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('stripe', 'paddle')),
  status text not null
    check (status in ('creating', 'open', 'completed', 'failed', 'expired')),
  provider_transaction_id text,
  checkout_url text,
  last_error text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 每用户跨支付商最多一个 creating/open attempt
create unique index if not exists billing_checkout_attempts_one_open_uidx
  on public.billing_checkout_attempts(user_id)
  where status in ('creating', 'open');

alter table public.billing_checkout_attempts enable row level security;

-- ============================================================================
-- 4. 通用事件表（幂等、乱序控制、审计）
-- ============================================================================
create table if not exists public.billing_events (
  provider text not null,
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  status text not null default 'received'
    check (status in ('received', 'processed', 'failed', 'ignored')),
  attempt_count integer not null default 0,
  user_id uuid references auth.users(id) on delete set null,
  provider_subscription_id text,
  payload jsonb,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_id)
);

alter table public.billing_events enable row level security;

-- ============================================================================
-- 5. subscriptions 表增加权益来源字段
-- ============================================================================
alter table public.subscriptions
  add column if not exists source_provider text,
  add column if not exists source_subscription_id text,
  add column if not exists entitlement_updated_at timestamptz;

alter table public.subscriptions
  drop constraint if exists subscriptions_source_provider_check;
alter table public.subscriptions
  add constraint subscriptions_source_provider_check
  check (source_provider in ('stripe', 'paddle', 'apple', 'google', 'admin'));

-- 回填现有数据
update public.subscriptions
set source_provider = case
      when plan = 'admin' or stripe_customer_id like 'admin_%' then 'admin'
      else 'stripe'
    end,
    source_subscription_id = stripe_subscription_id,
    entitlement_updated_at = coalesce(updated_at, now())
where source_provider is null;

-- 回填完成后设置 NOT NULL（允许 stripe_customer_id 为空，迁移期容忍）
-- 注意：不强制 source_provider not null，避免未来 edge case 阻塞写入
alter table public.subscriptions
  alter column stripe_customer_id drop not null;

-- 每用户最多一条当前权益
create unique index if not exists subscriptions_user_id_uidx
  on public.subscriptions(user_id);

-- ============================================================================
-- 6. 回填 billing_customers 和 provider_subscriptions（从现有 Stripe 数据）
-- ============================================================================
insert into public.billing_customers (user_id, provider, provider_customer_id)
select s.user_id, 'stripe', s.stripe_customer_id
from public.subscriptions s
where s.stripe_customer_id is not null
  and s.stripe_customer_id not like 'admin_%'
  and not exists (
    select 1 from public.billing_customers bc
    where bc.user_id = s.user_id and bc.provider = 'stripe'
  )
on conflict do nothing;

insert into public.provider_subscriptions (
  provider, provider_subscription_id, user_id, provider_customer_id,
  provider_price_id, plan, status,
  current_period_start, current_period_end, cancel_at_period_end,
  subscription_state_occurred_at, latest_transaction_id
)
select
  'stripe',
  s.stripe_subscription_id,
  s.user_id,
  s.stripe_customer_id,
  s.stripe_price_id,
  coalesce(s.plan, 'pro'),
  s.status,
  s.current_period_start,
  s.current_period_end,
  s.cancel_at_period_end,
  coalesce(s.updated_at, now()),
  null
from public.subscriptions s
where s.stripe_subscription_id is not null
  and s.stripe_customer_id not like 'admin_%'
on conflict (provider, provider_subscription_id) do update set
  status = excluded.status,
  current_period_start = excluded.current_period_start,
  current_period_end = excluded.current_period_end,
  cancel_at_period_end = excluded.cancel_at_period_end,
  updated_at = now();

-- ============================================================================
-- 7. 原子事件处理 RPC（Webhook 调用的唯一持久化入口）
-- ============================================================================
-- Edge Function 完成验签和业务校验后，构造标准化 effect 调用此 RPC。
-- RPC 在一个事务内完成：幂等领取 → upsert customer → 条件更新 subscription
-- → 投影当前权益 → 标记事件状态。
create or replace function public.process_billing_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_effect jsonb
) returns table(action text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_status text;
  v_effect_type text;
  v_user_id uuid;
  v_customer_id text;
  v_subscription_id text;
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
  v_is_subscription_event boolean;
begin
  -- 解析 effect（Edge Function 已校验过，这里做防御性提取）
  v_effect_type := p_effect->>'type';
  v_user_id := (p_effect->>'user_id')::uuid;
  v_customer_id := p_effect->>'customer_id';
  v_subscription_id := p_effect->>'subscription_id';
  v_price_id := p_effect->>'price_id';
  v_plan := coalesce(p_effect->>'plan', 'pro');
  v_status := p_effect->>'status';
  v_period_start := nullif(p_effect->>'period_start', '')::timestamptz;
  v_period_end := nullif(p_effect->>'period_end', '')::timestamptz;
  v_cancel_at_period_end := coalesce((p_effect->>'cancel_at_period_end')::boolean, false);
  v_transaction_id := p_effect->>'transaction_id';
  v_state_occurred_at := nullif(p_effect->>'state_occurred_at', '')::timestamptz;

  v_is_subscription_event := p_effect ? 'subscription_id' and p_effect->>'subscription_id' is not null;

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
      return query select 'duplicate'::text;
      return;
    end if;
  end if;

  -- 2. 处理 ignored 事件（不支持的事件类型或永久校验失败）
  if v_effect_type = 'ignore' then
    update public.billing_events
    set status = 'ignored', processed_at = now(), payload = p_payload
    where provider = p_provider and event_id = p_event_id;
    return query select 'processed'::text;
    return;
  end if;

  -- 3. upsert billing_customers（即使 customer.created 未到也能建立映射）
  if v_user_id is not null and v_customer_id is not null then
    insert into public.billing_customers (user_id, provider, provider_customer_id)
    values (v_user_id, p_provider, v_customer_id)
    on conflict (user_id, provider) do update set
      provider_customer_id = excluded.provider_customer_id,
      updated_at = now();
  end if;

  -- 4. 条件更新 provider_subscriptions（仅 subscription 事件）
  if v_subscription_id is not null and v_subscription_id <> '' then
    select subscription_state_occurred_at into v_prev_occurred_at
    from public.provider_subscriptions
    where provider = p_provider and provider_subscription_id = v_subscription_id;

    -- 乱序控制：新事件的 state_occurred_at 不能旧于已记录的
    if v_prev_occurred_at is null or v_state_occurred_at is null or v_state_occurred_at >= v_prev_occurred_at then
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
    else
      -- 旧事件，跳过但标记为 processed（不是 ignored，因为事件本身有效）
      update public.billing_events
      set status = 'processed', processed_at = now()
      where provider = p_provider and event_id = p_event_id;
      return query select 'stale'::text;
      return;
    end if;
  end if;

  -- 5. 投影当前权益到 subscriptions 表
  if v_user_id is not null then
    -- 读取当前权益
    select source_provider, status, plan into v_current_provider, v_current_status, v_current_plan
    from public.subscriptions
    where user_id = v_user_id
    limit 1;

    -- 权益投影规则：
    -- - admin 权益不可被覆盖
    -- - active/trialing 的当前权益不可被另一支付商覆盖
    -- - 同来源订阅可以更新
    -- - 当前权益已过期/取消后，新支付商可接管
    if v_current_plan = 'admin' then
      -- 管理员权益，跳过投影
      null;
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
    -- else: 另一支付商的 active/trialing 权益存在，不覆盖
  end if;

  -- 6. 标记事件为 processed
  update public.billing_events
  set status = 'processed', processed_at = now(), payload = p_payload
  where provider = p_provider and event_id = p_event_id;

  return query select 'processed'::text;
  return;

exception
  when others then
    -- 记录失败，让 Paddle 重试
    update public.billing_events
    set status = 'failed',
        attempt_count = attempt_count + 1,
        last_error = sqlerrm,
        payload = p_payload
    where provider = p_provider and event_id = p_event_id;
    return query select 'failed'::text;
    return;
end;
$$;

grant execute on function public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb)
  to service_role;
revoke execute on function public.process_billing_event(text, text, text, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;

-- ============================================================================
-- 8. Checkout attempt 原子领取 RPC
-- ============================================================================
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
  from public.billing_checkout_attempts
  where user_id = p_user_id
    and status in ('creating', 'open')
  order by created_at desc
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

grant execute on function public.claim_checkout_attempt(uuid, text)
  to service_role;
revoke execute on function public.claim_checkout_attempt(uuid, text)
  from public, anon, authenticated;

-- ============================================================================
-- 9. 更新 Checkout attempt 的 RPC（标记 open / completed / failed）
-- ============================================================================
create or replace function public.update_checkout_attempt(
  p_id uuid,
  p_status text,
  p_provider_transaction_id text default null,
  p_checkout_url text default null,
  p_last_error text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.billing_checkout_attempts
  set status = p_status,
      provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
      checkout_url = coalesce(p_checkout_url, checkout_url),
      last_error = p_last_error,
      updated_at = now()
  where id = p_id;
end;
$$;

grant execute on function public.update_checkout_attempt(uuid, text, text, text, text)
  to service_role;
revoke execute on function public.update_checkout_attempt(uuid, text, text, text, text)
  from public, anon, authenticated;
