-- 清除 user_commands 表中完全重复的指令行（按 user_id + label + text 分组）
-- 根因：通过 SQL 直接导入时，由于缺少唯一约束，同一条指令被插入了多次。
-- 保留策略：每组保留 created_at 最早的那条，删掉其余重复行。
-- 如果 created_at 也相同，则用 ctid（物理行标识）兜底判断。

-- 1. 先查看重复情况（仅诊断，不影响数据）
-- select user_id, label, text, count(*) as cnt
-- from public.user_commands
-- group by user_id, label, text
-- having count(*) > 1
-- order by cnt desc;

-- 2. 删除重复行，保留每组 created_at 最小的一条
--    如果 created_at 相同，保留 ctid 最小（物理最先插入）的那条
delete from public.user_commands c
using public.user_commands d
where c.user_id = d.user_id
  and c.label = d.label
  and c.text = d.text
  and (c.created_at, c.ctid) > (d.created_at, d.ctid);

-- 3. 添加唯一索引，防止未来再次出现重复
create unique index if not exists user_commands_user_label_text_uidx
  on public.user_commands (user_id, label, text);
