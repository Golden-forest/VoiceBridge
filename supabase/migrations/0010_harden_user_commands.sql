-- Keep user command authorization unchanged while avoiding per-row auth calls
-- and mutable trigger search paths.
drop policy if exists user_commands_select_own on public.user_commands;
create policy user_commands_select_own
  on public.user_commands for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists user_commands_insert_own on public.user_commands;
create policy user_commands_insert_own
  on public.user_commands for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists user_commands_update_own on public.user_commands;
create policy user_commands_update_own
  on public.user_commands for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists user_commands_delete_own on public.user_commands;
create policy user_commands_delete_own
  on public.user_commands for delete to authenticated
  using (user_id = (select auth.uid()));

alter function public.fill_user_id() set search_path = '';
alter function public.touch_updated_at() set search_path = '';
