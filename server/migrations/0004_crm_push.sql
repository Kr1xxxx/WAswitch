-- 同步到 CRM 第 2 步：员工电脑上传的聊天先加密暂存在这里，定时推给来财，推完就删，最多留 7 天。
CREATE TABLE crm_batches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  n INTEGER NOT NULL,          -- 条数（不加密，只用来控制每轮推多少）
  iv TEXT NOT NULL,            -- AES-GCM 随机 IV（base64）
  data TEXT NOT NULL,          -- 密文（base64），AAD = id|account_id|device_id
  created_at INTEGER NOT NULL
);
CREATE INDEX crm_batches_created ON crm_batches(created_at);
CREATE INDEX crm_batches_account ON crm_batches(account_id);

-- 只记条数，不记号码和内容
ALTER TABLE wa_accounts ADD COLUMN crm_stored INTEGER NOT NULL DEFAULT 0;   -- 已写进来财
ALTER TABLE wa_accounts ADD COLUMN crm_dropped INTEGER NOT NULL DEFAULT 0;  -- 对不上客户或被来财拒收，已丢弃
ALTER TABLE wa_accounts ADD COLUMN crm_pushed_at INTEGER;

INSERT INTO meta (key, value) VALUES ('crm_auth_fail_at', 0);
