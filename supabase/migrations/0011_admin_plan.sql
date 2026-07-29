-- Introduce `admin` plan: super-admin bypasses all quotas.
--
-- Identifies admins via the `is_admin boolean` column on `public.profiles`.
-- Admins are allowed unlimited monthly seconds, unlimited single-audio
-- duration, and bypass the per-minute rate limit.

alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- Mark the project owner as admin by email.
update public.profiles
  set is_admin = true,
      plan = 'admin',
      updated_at = now()
where email = 'huanglin37@mail3.sysu.edu.cn';

-- Also reflect admin status on subscriptions for front-end consistency.
insert into public.subscriptions (
  user_id,
  stripe_customer_id,
  plan,
  status,
  current_period_start,
  current_period_end
)
select
  p.user_id,
  'admin_' || p.user_id::text,
  'admin',
  'active',
  date_trunc('month', now()),
  date_trunc('month', now()) + interval '1 century'
from public.profiles p
where p.is_admin
  and not exists (
    select 1 from public.subscriptions s
    where s.user_id = p.user_id and s.plan = 'admin'
  )
on conflict do nothing;

-- Allow users to read their own is_admin flag (needed for UI).
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ============================================================================
-- Rewrite reserve_and_get_plan to support admin bypass.
-- ============================================================================
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
  v_monthly_seconds int;
  v_max_audio_seconds int;
  v_rate_limit_per_minute int;
  v_month_start timestamptz := date_trunc('month', now());
  v_used_seconds int := 0;
  v_recent_count int := 0;
  v_duration_seconds int := ceil(p_audio_duration_ms::numeric / 1000)::int;
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

  -- Limits (keep aligned with supabase/functions/_shared/plan_limits.ts).
  if v_plan = 'admin' then
    -- Effectively unlimited: 1M seconds/month (~277h), 1h per request, no rate limit.
    v_monthly_seconds := 1000000;
    v_max_audio_seconds := 3600;
    v_rate_limit_per_minute := 10000;
  elsif v_plan = 'pro' then
    v_monthly_seconds := 18000;
    v_max_audio_seconds := 60;
    v_rate_limit_per_minute := 30;
  else
    v_monthly_seconds := 600;
    v_max_audio_seconds := 60;
    v_rate_limit_per_minute := 10;
  end if;

  if v_duration_seconds > v_max_audio_seconds then
    return jsonb_build_object(
      'plan', v_plan,
      'max_audio_seconds', v_max_audio_seconds,
      'error_code', 'audio_too_long'
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || to_char(v_month_start, 'YYYY-MM'), 0)
  );

  select coalesce(sum(ceil(audio_duration_ms::numeric / 1000)), 0)::int
    into v_used_seconds
    from public.usage_events
    where user_id = p_user_id
      and status in ('success', 'processing')
      and created_at >= v_month_start;

  if v_used_seconds + v_duration_seconds > v_monthly_seconds then
    return jsonb_build_object(
      'plan', v_plan,
      'max_audio_seconds', v_max_audio_seconds,
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
      'max_audio_seconds', v_max_audio_seconds,
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
    'max_audio_seconds', v_max_audio_seconds,
    'error_code', null
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'plan', coalesce(v_plan, 'free'),
      'max_audio_seconds', coalesce(v_max_audio_seconds, 60),
      'error_code', 'duplicate_request'
    );
end;
$$;

revoke execute on function public.reserve_and_get_plan(uuid, uuid, text, text, int, int, text)
  from public, anon, authenticated;
grant execute on function public.reserve_and_get_plan(uuid, uuid, text, text, int, int, text)
  to service_role;
