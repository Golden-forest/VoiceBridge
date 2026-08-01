-- Align cloud ASR per-plan limits with LAN behavior and enforce millisecond-level
-- duration checks. Replaces the version defined in 0011_admin_plan.sql.
--
-- Changes vs 0011:
--   * per-request hard cap lowered: free=15s, pro=60s, admin=60s (was 60/60/3600).
--   * duration check now uses raw p_audio_duration_ms (no ceil-to-seconds).
--   * monthly usage accumulated in milliseconds (was sum-of-ceil-seconds).
--   * RPC returns max_audio_ms instead of max_audio_seconds.

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
  v_month_start timestamptz := date_trunc('month', now());
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
    v_monthly_ms := 60000 * 1000000;  -- effectively unlimited (~277h)
    v_max_audio_ms := 60000;
    v_rate_limit_per_minute := 10000;
  elsif v_plan = 'pro' then
    v_monthly_ms := 18000 * 1000;
    v_max_audio_ms := 60000;
    v_rate_limit_per_minute := 30;
  else
    v_monthly_ms := 600 * 1000;
    v_max_audio_ms := 15000;
    v_rate_limit_per_minute := 10;
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
    hashtextextended(p_user_id::text || ':' || to_char(v_month_start, 'YYYY-MM'), 0)
  );

  -- Monthly usage: sum raw milliseconds (no rounding).
  select coalesce(sum(audio_duration_ms), 0)
    into v_used_ms
    from public.usage_events
    where user_id = p_user_id
      and status in ('success', 'processing')
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
