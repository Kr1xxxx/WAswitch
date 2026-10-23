// 地区预设：让每个账号的时区和语言跟它走的代理节点所在地一致。
// "auto" 表示跟随本机设置（不覆盖）。
const presets = {
  auto: { label: '跟随本机', timezone: null, locale: null, languages: null },
  US: { label: '美国（纽约）', timezone: 'America/New_York', locale: 'en-US', languages: ['en-US', 'en'] },
  US_W: { label: '美国（洛杉矶）', timezone: 'America/Los_Angeles', locale: 'en-US', languages: ['en-US', 'en'] },
  GB: { label: '英国', timezone: 'Europe/London', locale: 'en-GB', languages: ['en-GB', 'en'] },
  DE: { label: '德国', timezone: 'Europe/Berlin', locale: 'de-DE', languages: ['de-DE', 'de', 'en'] },
  SG: { label: '新加坡', timezone: 'Asia/Singapore', locale: 'en-SG', languages: ['en-SG', 'en', 'zh-CN'] },
  MY: { label: '马来西亚', timezone: 'Asia/Kuala_Lumpur', locale: 'en-MY', languages: ['en-MY', 'en', 'ms'] },
  HK: { label: '香港', timezone: 'Asia/Hong_Kong', locale: 'zh-HK', languages: ['zh-HK', 'zh', 'en'] },
  TW: { label: '台湾', timezone: 'Asia/Taipei', locale: 'zh-TW', languages: ['zh-TW', 'zh', 'en'] },
  JP: { label: '日本', timezone: 'Asia/Tokyo', locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en'] },
  ID: { label: '印尼', timezone: 'Asia/Jakarta', locale: 'id-ID', languages: ['id-ID', 'id', 'en'] },
  TH: { label: '泰国', timezone: 'Asia/Bangkok', locale: 'th-TH', languages: ['th-TH', 'th', 'en'] },
  VN: { label: '越南', timezone: 'Asia/Ho_Chi_Minh', locale: 'vi-VN', languages: ['vi-VN', 'vi', 'en'] },
  PH: { label: '菲律宾', timezone: 'Asia/Manila', locale: 'en-PH', languages: ['en-PH', 'en', 'fil'] },
  IN: { label: '印度', timezone: 'Asia/Kolkata', locale: 'en-IN', languages: ['en-IN', 'en', 'hi'] },
  AE: { label: '阿联酋', timezone: 'Asia/Dubai', locale: 'en-AE', languages: ['en-AE', 'en', 'ar'] },
  BR: { label: '巴西', timezone: 'America/Sao_Paulo', locale: 'pt-BR', languages: ['pt-BR', 'pt', 'en'] },
  MX: { label: '墨西哥', timezone: 'America/Mexico_City', locale: 'es-MX', languages: ['es-MX', 'es', 'en'] },
};

// 根据代理出口的时区找对应的地区预设，找不到返回 null
function findByTimezone(tz) {
  const hit = Object.entries(presets).find(([, v]) => v.timezone === tz);
  return hit ? hit[0] : null;
}

module.exports = { presets, findByTimezone };
