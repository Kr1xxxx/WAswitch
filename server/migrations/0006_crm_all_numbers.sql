-- 同步到 CRM 改成团队号一律同步（shen 2026-11-02）：电脑上的 crm_sync 现在按“这个号看得见”算，不看旧的 crm_sync 列。
-- 升级前就登记的电脑游标已经比坐席版本新，不改版本就收不到新的 crm_sync。这里给看得见的坐席各出一个新版本
-- （device_seats_update_version 触发器在 SET visible 时就会跑，值不变也跑），电脑下次同步就拿到 crm_sync = true。
UPDATE device_seats SET visible = visible WHERE visible = 1;
