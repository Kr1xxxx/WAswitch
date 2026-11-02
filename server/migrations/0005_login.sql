-- 登录：员工用工作邮箱收验证码登录 WAswitch；老板和主管用同样的方式登录后台网页。没有密码。
-- 员工的邮箱就是已有的 users.email（不分大小写，唯一）。

-- 退出登录或被管理员「让他重新登录」的时间。重新登录时清空
ALTER TABLE devices ADD COLUMN logged_out_at INTEGER;

-- 验证码：同一个邮箱同一用途只留最新一个，库里只存哈希
CREATE TABLE login_codes (
  email TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL CHECK (purpose IN ('device', 'admin')),  -- 两种码互相不通用
  code_hash TEXT NOT NULL,                  -- SHA-256(purpose:email:code)
  expires_at INTEGER NOT NULL,              -- 10 分钟
  attempts INTEGER NOT NULL DEFAULT 0,      -- 试满 5 次作废
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (email, purpose)
);
CREATE INDEX login_codes_expires ON login_codes(expires_at);

-- 后台网页的会话：库里只存令牌的 SHA-256，7 天过期
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_user ON admin_sessions(user_id);
CREATE INDEX admin_sessions_expires ON admin_sessions(expires_at);

-- 登录策略：0 不用登录，1 提示登录（默认），2 必须登录
INSERT INTO meta (key, value) VALUES ('login_policy', 1);
