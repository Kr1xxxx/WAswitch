// 地区预设：让每个账号的时区跟它走的代理节点所在地一致。语言不在这里，所有账号统一中文（见 fingerprint.js）。
// "auto" 表示跟随本机设置（不覆盖）。
const presets = {
  auto: { label: '跟随本机', timezone: null },
  US: { label: '美国（纽约）', timezone: 'America/New_York' },
  US_W: { label: '美国（洛杉矶）', timezone: 'America/Los_Angeles' },
  GB: { label: '英国', timezone: 'Europe/London' },
  DE: { label: '德国', timezone: 'Europe/Berlin' },
  SG: { label: '新加坡', timezone: 'Asia/Singapore' },
  MY: { label: '马来西亚', timezone: 'Asia/Kuala_Lumpur' },
  HK: { label: '香港', timezone: 'Asia/Hong_Kong' },
  TW: { label: '台湾', timezone: 'Asia/Taipei' },
  JP: { label: '日本', timezone: 'Asia/Tokyo' },
  ID: { label: '印尼', timezone: 'Asia/Jakarta' },
  TH: { label: '泰国', timezone: 'Asia/Bangkok' },
  VN: { label: '越南', timezone: 'Asia/Ho_Chi_Minh' },
  PH: { label: '菲律宾', timezone: 'Asia/Manila' },
  IN: { label: '印度', timezone: 'Asia/Kolkata' },
  AE: { label: '阿联酋', timezone: 'Asia/Dubai' },
  BR: { label: '巴西', timezone: 'America/Sao_Paulo' },
  MX: { label: '墨西哥', timezone: 'America/Mexico_City' },
};

// 根据代理出口的时区找对应的地区预设，找不到返回 null
function findByTimezone(tz) {
  const hit = Object.entries(presets).find(([, v]) => v.timezone === tz);
  return hit ? hit[0] : null;
}

// 地区的值：预设的 key（如 JP），或者 "tz:时区名"（如 tz:America/Toronto，预设里没有的出口直接用测到的时区）
const TZ_PREFIX = 'tz:';
function validTimezone(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{1,60}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
function isValidRegion(region) {
  if (typeof region !== 'string') return false;
  if (region.startsWith(TZ_PREFIX)) return validTimezone(region.slice(TZ_PREFIX.length));
  return Object.prototype.hasOwnProperty.call(presets, region);
}
// 出口时区 -> 地区值：有预设用预设，没有就直接存时区；时区无效返回 null
function regionForTimezone(tz) {
  return findByTimezone(tz) || (validTimezone(tz) ? TZ_PREFIX + tz : null);
}
function timezoneOf(region) {
  if (typeof region === 'string' && region.startsWith(TZ_PREFIX)) return region.slice(TZ_PREFIX.length);
  return (presets[region] || presets.auto).timezone;
}
function regionLabel(region) {
  if (typeof region === 'string' && region.startsWith(TZ_PREFIX)) return `出口时区（${region.slice(TZ_PREFIX.length)}）`;
  return (presets[region] || presets.auto).label;
}

module.exports = { presets, findByTimezone, isValidRegion, regionForTimezone, timezoneOf, regionLabel };
