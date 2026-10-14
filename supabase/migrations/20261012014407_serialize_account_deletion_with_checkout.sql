-- Deletion and checkout share the same per-user lock. A pending checkout
-- prevents deleting its owner, and a deletion intent prevents new checkouts.
alter table public.profiles add column account_deletion_requested_at timestamptz;
-- Profiles are client-readable, service-written in this repository. Explicit
-- table-level revocation also removes any inherited broad UPDATE grant;
-- service_role customer/email writes and client SELECT remain unchanged.
revoke update on public.profiles from public, anon, authenticated;
revoke update (account_deletion_requested_at) on public.profiles from public, anon, authenticated;

create function public.begin_account_deletion(p_user_id uuid)
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
    where user_id = p_user_id and status in ('creating', 'open')
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
  if exists (
    select 1 from public.profiles where user_id = p_user_id
      and account_deletion_requested_at is not null
  ) then
    return jsonb_build_object('status', 'account_deleting', 'acquired', false);
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
