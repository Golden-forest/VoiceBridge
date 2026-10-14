-- Provider cancellation failure previously left account_deletion_requested_at
-- set forever with no reversal path, permanently forbidding new purchases for
-- a user who abandoned deletion. The account-delete Edge Function releases
-- the intent on that failure path via this RPC.
create function public.clear_account_deletion_request(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_cleared boolean;
begin
  update public.profiles
  set account_deletion_requested_at = null
  where user_id = p_user_id and account_deletion_requested_at is not null
  returning true into v_cleared;
  return coalesce(v_cleared, false);
end;
$$;
revoke all on function public.clear_account_deletion_request(uuid) from public, anon, authenticated;
grant execute on function public.clear_account_deletion_request(uuid) to service_role;
