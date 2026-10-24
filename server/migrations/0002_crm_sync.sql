-- 同步到 CRM 的开关（第 1 步）：管理员按号打开，随坐席同步下发给电脑。默认关。
ALTER TABLE wa_accounts ADD COLUMN crm_sync INTEGER NOT NULL DEFAULT 0;
