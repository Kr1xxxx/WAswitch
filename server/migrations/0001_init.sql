-- WAswitch 团队后台：第一阶段（登记、坐席、状态监控）
-- 时间一律是服务器毫秒时间戳。

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT COLLATE NOCASE UNIQUE,          -- 坐席可以没有邮箱（不登录后台）
  role TEXT NOT NULL CHECK (role IN ('owner', 'supervisor', 'agent')),
  group_id TEXT REFERENCES groups(id),
  disabled_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,            -- SHA-256(设备令牌)，十六进制
  app_version TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  mem_mb INTEGER NOT NULL DEFAULT 0,
  low_mem INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE enroll_codes (
  code_hash TEXT PRIMARY KEY,                 -- SHA-256(登记码)
  user_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- 团队的 WhatsApp 账号（坐席）
CREATE TABLE wa_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  number_label TEXT NOT NULL DEFAULT '',      -- 管理员手填的号码备注
  group_id TEXT REFERENCES groups(id),
  user_id TEXT REFERENCES users(id),          -- 分给谁
  device_id TEXT REFERENCES devices(id),      -- 在哪台电脑上
  mode TEXT NOT NULL DEFAULT 'web' CHECK (mode IN ('web', 'lite')),
  color TEXT NOT NULL DEFAULT '',
  expected_country TEXT NOT NULL DEFAULT '',  -- 两位国家代码，空 = 不检查
  note TEXT NOT NULL DEFAULT '',              -- 只从后台发给客户端
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX wa_accounts_device ON wa_accounts(device_id);
CREATE INDEX wa_accounts_group ON wa_accounts(group_id);

-- 每台设备上每个团队号的显示记录。收回 = 显式写 visible=0，不靠"少一行"。
CREATE TABLE device_seats (
  device_id TEXT NOT NULL REFERENCES devices(id),
  account_id TEXT NOT NULL REFERENCES wa_accounts(id),
  visible INTEGER NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (device_id, account_id)
);
CREATE INDEX device_seats_version ON device_seats(device_id, version);

-- 每个账号最新一份状态。只在内容变化时写。
CREATE TABLE account_status (
  account_id TEXT PRIMARY KEY REFERENCES wa_accounts(id),
  device_id TEXT NOT NULL,
  state TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  proxy_ok INTEGER,                           -- 1 / 0 / NULL（直连或没测过）
  proxy_ms INTEGER,
  exit_ip TEXT NOT NULL DEFAULT '',
  exit_country TEXT NOT NULL DEFAULT '',
  exit_changed INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER NOT NULL
);

CREATE TABLE status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''             -- 只能是枚举或两位国家代码
);
CREATE INDEX status_events_account ON status_events(account_id, at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_log_at ON audit_log(at);

-- 登记接口限速：按 IP 每 10 分钟一个窗口
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO meta (key, value) VALUES ('version', 0), ('allow_private', 1);
