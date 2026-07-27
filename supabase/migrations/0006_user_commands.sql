-- 用户私有指令库（每用户隔离，由 Supabase RLS 保证用户只能 CRUD 自己的指令）
-- 数据来源：hosted-pwa/public/commands.json（剔除 Personal 隐私类别后的 142 条）

create table if not exists public.user_commands (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null,
  text        text not null,
  category    text not null default 'uncategorized',
  sort_order  integer not null default 0,
  is_favorite boolean not null default false,
  last_used_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists user_commands_user_id_idx
  on public.user_commands (user_id);

alter table public.user_commands enable row level security;

-- RLS: 用户只能 CRUD 自己的指令
drop policy if exists user_commands_select_own on public.user_commands;
create policy user_commands_select_own
  on public.user_commands for select to authenticated
  using (user_id = auth.uid());

drop policy if exists user_commands_insert_own on public.user_commands;
create policy user_commands_insert_own
  on public.user_commands for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists user_commands_update_own on public.user_commands;
create policy user_commands_update_own
  on public.user_commands for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists user_commands_delete_own on public.user_commands;
create policy user_commands_delete_own
  on public.user_commands for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on public.user_commands to authenticated;

-- 自动填充 user_id：客户端无需（也不应）显式传递 user_id。
-- 这样 RLS 的 with check (user_id = auth.uid()) 才能在客户端省略 user_id 时通过。
create or replace function public.fill_user_id()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists user_commands_fill_user_id on public.user_commands;
create trigger user_commands_fill_user_id
  before insert on public.user_commands
  for each row execute function public.fill_user_id();

-- updated_at 触发器
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_commands_touch_updated_at on public.user_commands;
create trigger user_commands_touch_updated_at
  before update on public.user_commands
  for each row execute function public.touch_updated_at();

-- 种子数据说明：种子指令不在 SQL 里硬编码。
-- PWA 端通过"导入种子指令"按钮从 hosted-pwa/public/commands.json 拉取并写入当前账号。
-- 见 hosted-pwa/public/commandStore.js 的 importSeedCommands()。
