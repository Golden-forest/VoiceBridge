-- ============================================================
-- VoiceBridge 设备表权限治本修复
-- 问题：migration 0004 第 77-79 行 revoke 了 update 全权限，只 grant 了部分列，
--      导致手机端 upsert device 记录时 PostgreSQL 返回 42501 permission denied。
--      这进而导致 Realtime RLS policy 找不到匹配 device 记录，订阅失败 (CHANNEL_ERROR)。
--
-- 本脚本幂等，可在 Supabase Dashboard → SQL Editor 反复运行。
-- ============================================================

-- 1. GRANT 完整的 insert + update 列权限（覆盖 upsert 所需的所有列）
--    之前只 grant 了 (name, platform, app_version, status, last_seen_at, updated_at)
--    缺：id, user_id, runtime_user_id, device_type, paired_at, created_at
revoke insert on public.devices from authenticated;
revoke update on public.devices from authenticated;

grant insert (id, user_id, runtime_user_id, name, device_type, platform, app_version, status, paired_at, last_seen_at, created_at, updated_at)
  on public.devices to authenticated;

grant update (id, user_id, runtime_user_id, name, device_type, platform, app_version, status, paired_at, last_seen_at, updated_at)
  on public.devices to authenticated;

-- 2. 验证：列出 authenticated 角色在 devices 表上的列级权限
--    执行后应能看到上述所有列都同时 grant 了 INSERT 和 UPDATE
select
  column_name,
  string_agg(privilege_type, ', ') as privileges
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'devices'
  and grantee = 'authenticated'
group by column_name
order by column_name;

-- 完成
