-- Add plan column to profiles if it doesn't exist
alter table public.profiles
  add column if not exists plan text not null default 'free';

-- Keep the security-definer trigger function out of the exposed public schema.
create schema if not exists private;
revoke all on schema private from public;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, plan)
  values (
    new.id,
    new.email,
    'free'
  )
  on conflict (user_id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

-- Backfill profiles for users who registered before this trigger existed.
insert into public.profiles (user_id, email, plan)
select id, email, 'free'
from auth.users
on conflict (user_id) do update
  set email = excluded.email,
      updated_at = now();

-- Trigger on auth.users AFTER INSERT to call handle_new_user
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_user();

-- Remove the former exposed trigger function after the trigger points at private.
drop function if exists public.handle_new_user();
