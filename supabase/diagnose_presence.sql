-- ============================================================
-- 诊断 presence policy 为什么不匹配 (只读,不改任何东西)
-- ============================================================

-- 1. 看看 realtime.messages 表的真实结构
select
  column_name,
  data_type
from information_schema.columns
where table_schema = 'realtime'
  and table_name = 'messages'
order by ordinal_position;

-- 2. 看 extension 字段在 policy 调用时的实际值
--    用 psql EXECUTE 模拟 RLS 上下文,但要真实需要 JWT,这里只能看定义
select
  policyname,
  cmd,
  qual
from pg_policies
where schemaname = 'realtime'
  and tablename = 'messages'
  and policyname like '%presence%'
order by policyname;

-- 3. 看看 Realtime 是否在用 row-level security
select
  relname,
  relrowsecurity,
  relforcerowsecurity
from pg_class
where relname = 'messages'
  and relnamespace = (select oid from pg_namespace where nspname = 'realtime');

-- 4. 关键!realtime topic 函数的定义
--    它返回什么?是带前缀还是不带?
select pg_get_functiondef(oid) as func_def
from pg_proc
where proname = 'topic'
  and pronamespace = (select oid from pg_namespace where nspname = 'realtime');

-- 5. 当前用户 devices 表数据
--    验证 exists 子查询能不能命中
select id, user_id, runtime_user_id, status, name
from public.devices
where user_id = '075da578-c6cb-4ae9-9026-db68df2e52c4'
   or runtime_user_id = '075da578-c6cb-4ae9-9026-db68df2e52c4';

-- 6. 测试 realtime.topic() 函数能不能在普通 SQL 上下文里调用
select realtime.topic() as topic_value_in_sql_context;
