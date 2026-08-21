-- Edge 函数保温：issue-asr-request / transcribe 冷启动实测 2.5~4.5s，
-- 是云端语音识别延迟尖刺的主要来源。pg_cron 每 2 分钟用 pg_net 轻量
-- ping 一次（无鉴权返回 401/405 即可——Deno isolate 已完成模块加载，
-- 冷启动开销已被支付），把冷启动概率压到接近零。
--
-- 纯增量：失败仅记录到 net._http_response，不影响任何业务表。

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('warm-asr-edge-functions') where exists (
  select 1 from cron.job where jobname = 'warm-asr-edge-functions'
);

select cron.schedule(
  'warm-asr-edge-functions',
  '*/2 * * * *',
  $$
  select net.http_get(
    url := 'https://gqxxknusznbunkiznnal.supabase.co/functions/v1/issue-asr-request',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  select net.http_get(
    url := 'https://gqxxknusznbunkiznnal.supabase.co/functions/v1/transcribe',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
