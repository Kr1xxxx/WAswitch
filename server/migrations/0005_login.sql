-- 登录：员工用登录名和密码登录 WAswitch；老板和主管用同一套账号登录后台网页。
-- 登录名统一存小写，比较时也不分大小写。
ALTER TABLE users ADD COLUMN login_name TEXT COLLATE NOCASE;
ALTER TABLE users ADD COLUMN pass_hash TEXT;        -- PBKDF2-SHA256 结果，十六进制
ALTER TABLE users ADD COLUMN pass_salt TEXT;        -- 16 字节随机盐，十六进制
ALTER TABLE users ADD COLUMN pass_iter INTEGER;     -- 迭代次数，登录时按当前设置自动升级
ALTER TABLE users ADD COLUMN pass_changed_at INTEGER;
CREATE UNIQUE INDEX users_login_name ON users(login_name);

-- 退出登录或被重置密码的时间。重新登录时清空
ALTER TABLE devices ADD COLUMN logged_out_at INTEGER;

-- 后台网页的会话：库里只存令牌的 SHA-256，12 小时过期
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
