-- 版本号随坐席写入一起提交，不能在事务之外预留。
UPDATE meta SET value = MAX(value, COALESCE((SELECT MAX(version) FROM device_seats), 0)) WHERE key = 'version';

CREATE TRIGGER device_seats_insert_version AFTER INSERT ON device_seats
BEGIN
  UPDATE meta SET value = value + 1 WHERE key = 'version';
  UPDATE device_seats SET version = (SELECT value FROM meta WHERE key = 'version')
    WHERE device_id = NEW.device_id AND account_id = NEW.account_id;
END;

CREATE TRIGGER device_seats_update_version AFTER UPDATE OF visible ON device_seats
BEGIN
  UPDATE meta SET value = value + 1 WHERE key = 'version';
  UPDATE device_seats SET version = (SELECT value FROM meta WHERE key = 'version')
    WHERE device_id = NEW.device_id AND account_id = NEW.account_id;
END;

-- 升级时先撤掉与当前归属不一致的历史坐席；客户端仍会拿到新的隐藏版本。
UPDATE device_seats SET visible = 0 WHERE visible = 1 AND NOT EXISTS (
  SELECT 1 FROM wa_accounts a WHERE a.id = device_seats.account_id
    AND a.device_id = device_seats.device_id AND a.deleted_at IS NULL
);
CREATE UNIQUE INDEX device_seats_one_visible ON device_seats(account_id) WHERE visible = 1;
