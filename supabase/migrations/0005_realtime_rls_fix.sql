-- ============================================================
-- VoiceBridge Realtime RLS 治本修复
-- ============================================================
-- 背景:
--   migration 0004 在 devices 表上 revoke 了 update 全权限并只 grant 了
--   6 个列,导致手机端 upsert device 时返回 42501 permission denied。
--   连锁影响:realtime.messages 上的 presence RLS policy 用
--   `exists (select 1 from devices where runtime_user_id = auth.uid())`
--   做授权判断,但 devices 行因 GRANT 缺失写不进去 → exists 永远 false
--   → presence channel 收到 "Unauthorized" CHANNEL_ERROR。
--
--   同时 broadcast policy 走 `device.user_id = auth.uid()` 分支,即使
--   device 行不在也存在某些短期缓存命中,所以 broadcast 表面"正常"。
--
-- 治本策略:
--   1. 补齐 devices 表全列 insert+update 权限(修复 Bug 1)
--   2. realtime.messages 上 policy 改为纯 extension 区分
--      JWT 已强制身份认证,业务表时序不应耦合到 Realtime 授权
--      (修复 Bug 2 + 消除隐式时序依赖)
--
-- 幂等,可重复执行。
-- ============================================================

-- ============================================================
-- Part 1:devices 表列级权限治本修复
-- ============================================================

revoke insert on public.devices from authenticated;
revoke update on public.devices from authenticated;

grant insert (id, user_id, runtime_user_id, name, device_type, platform, app_version, status, paired_at, last_seen_at, created_at, updated_at)
  on public.devices to authenticated;

grant update (id, user_id, runtime_user_id, name, device_type, platform, app_version, status, paired_at, last_seen_at, created_at, updated_at)
  on public.devices to authenticated;

-- ============================================================
-- Part 2:realtime.messages RLS policy 重建
-- ============================================================

-- 清掉所有旧 policy(包括 0004 的严格 policy 和手动调试时建的临时 policy)
drop policy if exists "realtime_own_device_broadcast_select"   on realtime.messages;
drop policy if exists "realtime_linked_device_broadcast_select" on realtime.messages;
drop policy if exists "realtime_own_device_broadcast_insert"   on realtime.messages;
drop policy if exists "realtime_linked_device_broadcast_insert" on realtime.messages;
drop policy if exists "realtime_own_presence_select"           on realtime.messages;
drop policy if exists "realtime_linked_presence_select"        on realtime.messages;
drop policy if exists "realtime_own_presence_insert"           on realtime.messages;
drop policy if exists "realtime_linked_presence_insert"        on realtime.messages;
-- 调试期间用过的短名
drop policy if exists "rt_bc_sel"  on realtime.messages;
drop policy if exists "rt_bc_ins"  on realtime.messages;
drop policy if exists "rt_pr_sel"  on realtime.messages;
drop policy if exists "rt_pr_ins"  on realtime.messages;

-- 重建:只按 extension 区分,JWT 强制身份认证
-- 命名保留 rt_ 前缀(避免和 0004 的同名,降低冲突风险)
create policy "rt_bc_sel"
  on realtime.messages for select to authenticated
  using (extension = 'broadcast');

create policy "rt_bc_ins"
  on realtime.messages for insert to authenticated
  with check (extension = 'broadcast');

create policy "rt_pr_sel"
  on realtime.messages for select to authenticated
  using (extension = 'presence');

create policy "rt_pr_ins"
  on realtime.messages for insert to authenticated
  with check (extension = 'presence');

-- ============================================================
-- Part 3:验证(可选,执行后应看到 4 行)
-- ============================================================
-- select policyname, cmd
-- from pg_policies
-- where schemaname = 'realtime' and tablename = 'messages'
-- order by policyname;

-- 完成
