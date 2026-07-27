-- Resolve the effective subscription plan and reserve ASR usage in one database round trip.
create index if not exists subscriptions_user_updated_at_idx
  on public.subscriptions (user_id, updated_at desc);

create index if not exists usage_events_user_created_at_idx
  on public.usage_events (user_id, created_at desc);

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
  v_monthly_seconds int;
  v_max_audio_seconds int;
  v_rate_limit_per_minute int;
  v_month_start timestamptz := date_trunc('month', now());
  v_used_seconds int := 0;
  v_recent_count int := 0;
  v_duration_seconds int := ceil(p_audio_duration_ms::numeric / 1000)::int;
begin
  if p_cached_plan in ('free', 'pro') then
    v_plan := p_cached_plan;
  else
    select case
      when status in ('active', 'trialing') and plan = 'pro' then 'pro'
      else 'free'
    end
      into v_plan
      from public.subscriptions
      where user_id = p_user_id
      order by updated_at desc
      limit 1;
    v_plan := coalesce(v_plan, 'free');
  end if;

  -- Keep these values aligned with supabase/functions/_shared/plan_limits.ts.
  if v_plan = 'pro' then
    v_monthly_seconds := 18000;
    v_max_audio_seconds := 60;
    v_rate_limit_per_minute := 30;
  else
    v_monthly_seconds := 18000;
    v_max_audio_seconds := 60;
    v_rate_limit_per_minute := 30;
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
