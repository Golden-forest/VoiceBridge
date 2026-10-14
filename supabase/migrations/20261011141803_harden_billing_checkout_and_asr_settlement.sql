-- Retain uncertain provider consumption in the quota ledger. Expiration closes
-- abandoned reservations; it does not refund a request which may have run.
alter table public.usage_events drop constraint if exists usage_events_status_check;
alter table public.usage_events add constraint usage_events_status_check
  check (status in ('processing', 'success', 'failed', 'rejected', 'unknown'));
alter table public.usage_events add column if not exists settled_at timestamptz;
create index if not exists usage_events_pending_user_created_idx
  on public.usage_events(user_id, created_at) where status = 'processing';
update public.usage_events
set status = 'unknown', error_code = 'reservation_expired_unknown', settled_at = now()
where status = 'processing' and created_at < now() - interval '15 minutes';

create or replace function public.reserve_and_get_plan(
  p_user_id uuid,
  p_request_id uuid,
  p_provider text,
  p_mode text,
  p_audio_duration_ms int,
  p_audio_size_bytes int,
  p_cached_plan text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_plan text;
  v_is_admin boolean := false;
  v_monthly_ms bigint;
  v_max_audio_ms int;
  v_rate_limit_per_minute int;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_used_ms bigint := 0;
  v_recent_count int := 0;
begin
  -- Resolve plan: trust cached plan only if not admin (admin status can change,
  -- so always re-check from DB to avoid privilege escalation via stale cache).
  if p_cached_plan in ('free', 'pro') then
    v_plan := p_cached_plan;
  else
    select case
      when status in ('active', 'trialing') and plan = 'pro' then 'pro'
      when plan = 'admin' then 'admin'
      else 'free'
    end
      into v_plan
      from public.subscriptions
      where user_id = p_user_id
      order by updated_at desc
      limit 1;
    v_plan := coalesce(v_plan, 'free');
  end if;

  -- Check admin flag from profiles (independent of subscription table).
  select coalesce(is_admin, false)
    into v_is_admin
    from public.profiles
    where user_id = p_user_id;

  if v_is_admin then
    v_plan := 'admin';
  end if;

  -- Limits (keep aligned with src/shared/planLimits.js and
  -- supabase/functions/_shared/plan_limits.ts).
  if v_plan = 'admin' then
    v_monthly_ms := 60000::bigint * 1000000;  -- effectively unlimited (~277h)
    v_max_audio_ms := 60000;
    v_rate_limit_per_minute := 10000;
  elsif v_plan = 'pro' then
    v_monthly_ms := 18000::bigint * 1000;
    v_max_audio_ms := 60000;
    v_rate_limit_per_minute := 30;
  else
    v_monthly_ms := 600::bigint * 1000;
    v_max_audio_ms := 15000;
    v_rate_limit_per_minute := 10;
  end if;

  if p_audio_duration_ms is null or p_audio_duration_ms <= 0
     or p_audio_size_bytes is null or p_audio_size_bytes <= 0 then
    raise exception 'Invalid verified audio metadata';
  end if;

  -- Hard cap: per-request duration limit, millisecond-precise.
  if p_audio_duration_ms > v_max_audio_ms then
    return jsonb_build_object(
      'plan', v_plan,
      'max_audio_ms', v_max_audio_ms,
      'error_code', 'audio_too_long'
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || to_char(v_month_start at time zone 'UTC', 'YYYY-MM'), 0)
  );

  -- Run under the user's quota lock on every reservation. A crashed client or
  -- failed background write cannot leave processing indefinitely. Unknown
  -- consumption remains charged until trusted provider evidence resolves it.
  update public.usage_events
  set status = 'unknown', error_code = 'reservation_expired_unknown', settled_at = now()
  where user_id = p_user_id and status = 'processing'
    and created_at < now() - interval '15 minutes';

  -- Monthly usage: sum raw milliseconds (no rounding).
  select coalesce(sum(audio_duration_ms), 0)
    into v_used_ms
    from public.usage_events
    where user_id = p_user_id
      and status in ('success', 'processing', 'unknown')
      and created_at >= v_month_start;

  if v_used_ms + p_audio_duration_ms > v_monthly_ms then
    return jsonb_build_object(
      'plan', v_plan,
      'max_audio_ms', v_max_audio_ms,
      'error_code', 'quota_exceeded'
    );
  end if;

  select count(*)::int
    into v_recent_count
    from public.usage_events
    where user_id = p_user_id
      and created_at >= now() - interval '1 minute';

  if v_recent_count >= v_rate_limit_per_minute then
    return jsonb_build_object(
      'plan', v_plan,
      'max_audio_ms', v_max_audio_ms,
      'error_code', 'rate_limited'
    );
  end if;

  insert into public.usage_events (
    user_id,
    request_id,
    provider,
    mode,
    audio_duration_ms,
    audio_size_bytes,
    status
  ) values (
    p_user_id,
    p_request_id,
    p_provider,
    p_mode,
    p_audio_duration_ms,
    p_audio_size_bytes,
    'processing'
  );

  return jsonb_build_object(
    'plan', v_plan,
    'max_audio_ms', v_max_audio_ms,
    'error_code', null
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'plan', coalesce(v_plan, 'free'),
      'max_audio_ms', coalesce(v_max_audio_ms, 60000),
      'error_code', 'duplicate_request'
    );
end;
$$;

revoke execute on function public.reserve_and_get_plan(uuid, uuid, text, text, int, int, text)
  from public, anon, authenticated;
grant execute on function public.reserve_and_get_plan(uuid, uuid, text, text, int, int, text)
  to service_role;


-- A lease token fences stale workers. A provider request, once started, is
-- never automatically recreated after timeout: Paddle does not document a
-- general transaction-create idempotency key. Keep uncertain attempts for
-- reconciliation rather than risk another payable transaction.
alter table public.billing_checkout_attempts
  add column if not exists lease_token uuid,
  add column if not exists provider_request_started_at timestamptz;
-- Legacy creating attempts may already have called Paddle; treat as uncertain.
update public.billing_checkout_attempts
set provider_request_started_at = coalesce(provider_request_started_at, updated_at)
where status = 'creating';

drop function if exists public.claim_checkout_attempt(uuid, text);
create function public.claim_checkout_attempt(p_user_id uuid, p_provider text)
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

create or replace function public.start_checkout_provider_request(p_id uuid, p_lease_token uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_updated uuid;
begin
  update public.billing_checkout_attempts
  set provider_request_started_at = now(), updated_at = now()
  where id = p_id and lease_token = p_lease_token and status = 'creating'
    and provider_request_started_at is null
  returning id into v_updated;
  return v_updated is not null;
end;
$$;

-- Retire the unfenced updater so older functions cannot override a new lease.
drop function if exists public.update_checkout_attempt(uuid, text, text, text, text);
create function public.update_checkout_attempt(
  p_id uuid, p_lease_token uuid, p_status text,
  p_provider_transaction_id text default null, p_checkout_url text default null,
  p_last_error text default null
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_updated uuid;
begin
  if p_status not in ('open', 'failed', 'creating') then raise exception 'Invalid checkout transition'; end if;
  if p_status = 'open' and (p_provider_transaction_id is null or p_checkout_url is null) then
    raise exception 'An open checkout requires a transaction and URL';
  end if;
  update public.billing_checkout_attempts
  set status = p_status,
      provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
      checkout_url = coalesce(p_checkout_url, checkout_url),
      last_error = p_last_error, updated_at = now()
  where id = p_id and lease_token = p_lease_token and status = 'creating'
    and provider_request_started_at is not null
  returning id into v_updated;
  return v_updated is not null;
end;
$$;

revoke all on function public.claim_checkout_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.start_checkout_provider_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.update_checkout_attempt(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(uuid, text) to service_role;
grant execute on function public.start_checkout_provider_request(uuid, uuid) to service_role;
grant execute on function public.update_checkout_attempt(uuid, uuid, text, text, text, text) to service_role;
