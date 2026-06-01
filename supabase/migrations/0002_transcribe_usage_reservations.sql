alter table public.usage_events
  drop constraint if exists usage_events_status_check;

alter table public.usage_events
  add constraint usage_events_status_check
  check (status in ('processing', 'success', 'failed', 'rejected'));

create unique index if not exists usage_events_user_request_id_idx
  on public.usage_events (user_id, request_id);

create or replace function public.reserve_transcribe_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_provider text,
  p_mode text,
  p_audio_duration_ms int,
  p_audio_size_bytes int,
  p_monthly_seconds int,
  p_rate_limit_per_minute int
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now());
  v_used_seconds int := 0;
  v_recent_count int := 0;
  v_duration_seconds int := ceil(p_audio_duration_ms::numeric / 1000)::int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || to_char(v_month_start, 'YYYY-MM'), 0));

  select coalesce(sum(ceil(audio_duration_ms::numeric / 1000)), 0)::int
    into v_used_seconds
    from public.usage_events
    where user_id = p_user_id
      and status in ('success', 'processing')
      and created_at >= v_month_start;

  if v_used_seconds + v_duration_seconds > p_monthly_seconds then
    return 'quota_exceeded';
  end if;

  select count(*)::int
    into v_recent_count
    from public.usage_events
    where user_id = p_user_id
      and created_at >= now() - interval '1 minute';

  if v_recent_count >= p_rate_limit_per_minute then
    return 'rate_limited';
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

  return null;
exception
  when unique_violation then
    return 'duplicate_request';
end;
$$;

revoke execute on function public.reserve_transcribe_usage(uuid, uuid, text, text, int, int, int, int) from public;
revoke execute on function public.reserve_transcribe_usage(uuid, uuid, text, text, int, int, int, int) from anon;
revoke execute on function public.reserve_transcribe_usage(uuid, uuid, text, text, int, int, int, int) from authenticated;
grant execute on function public.reserve_transcribe_usage(uuid, uuid, text, text, int, int, int, int) to service_role;
