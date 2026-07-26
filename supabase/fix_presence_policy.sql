-- ============================================================
-- VoiceBridge Presence Channel 修复
-- 问题：user:<uid>:presence 这个 channel 订阅被 Realtime 拒绝 (Unauthorized)。
--      device:<uid>:<deviceId> 的 broadcast channel 正常工作。
--      所以问题在 presence 这条 policy。
--
-- 修复策略：
--   1. 删掉所有 presence 相关 policy（own + linked）
--   2. 用最简形式重建：authenticated 用户可以订阅自己的 presence channel
--      （topic = 'user:' || auth.uid() || ':presence'）
--   3. 桌面端通过 device.runtime_user_id 反向匹配仍然保留（linked 分支）
--
-- 幂等，可重复运行。
-- ============================================================

-- 1. 清掉所有 presence policy
drop policy if exists "realtime_own_presence_select" on realtime.messages;
drop policy if exists "realtime_linked_presence_select" on realtime.messages;
drop policy if exists "realtime_own_presence_insert" on realtime.messages;
drop policy if exists "realtime_linked_presence_insert" on realtime.messages;

-- 2. presence SELECT policy
--    分支 A: 自己的 presence（用户在 PWA 端订阅自己的频道）
--    分支 B: linked 设备（桌面 agent 用 runtime_user_id 订阅手机用户的 presence）
create policy "realtime_presence_select"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and (
      -- 自己的 presence channel
      (select realtime.topic()) = 'user:' || (select auth.uid()) || ':presence'
      -- 桌面 agent（runtime_user_id 等于当前 uid）订阅手机用户的 presence
      or exists (
        select 1
        from public.devices as device
        where device.status = 'active'
          and device.runtime_user_id = (select auth.uid())
          and (select realtime.topic()) = 'user:' || device.user_id || ':presence'
      )
    )
  );

-- 3. presence INSERT policy（同样的逻辑）
create policy "realtime_presence_insert"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (
      (select realtime.topic()) = 'user:' || (select auth.uid()) || ':presence'
      or exists (
        select 1
        from public.devices as device
        where device.status = 'active'
          and device.runtime_user_id = (select auth.uid())
          and (select realtime.topic()) = 'user:' || device.user_id || ':presence'
      )
    )
  );

-- 4. 验证：列出当前 realtime.messages 上的所有 policy
select
  policyname,
  cmd,
  regexp_replace(qual, '\s+', ' ', 'g') as using_clause
from pg_policies
where schemaname = 'realtime'
  and tablename = 'messages'
order by policyname;

-- 完成
