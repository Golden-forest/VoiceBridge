-- Add plan column to profiles if it doesn't exist
alter table public.profiles
  add column if not exists plan text not null default 'free';

-- Function to auto-create a profile when a new user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, plan)
  values (
    new.id,
    new.email,
    'free'
  );
  return new;
end;
$$;

-- Trigger on auth.users AFTER INSERT to call handle_new_user
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
