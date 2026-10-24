// 轻量模式用的 WhatsApp 网页版版本号。
// Baileys 内置的版本号会过期，过期后 WhatsApp 返回 405，所有轻量账号同时连不上。
// 所以连接前经账号自己的代理向 web.whatsapp.com 查一次当前版本（只连 WhatsApp，不连 GitHub）。
// 查不到就用内置版本并记日志。版本号和账号无关，整个后台进程共用一份，6 小时内不重复查。
import { fetchLatestWaWebVersion } from 'baileys';

const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAIL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;

let cached = null; // { version, at }
let failedAt = 0;
let inflight = null;

// 返回 [2, 3000, N]；查不到时返回 undefined（Baileys 会用内置版本）
export async function waVersion(dispatcher, log, fetchVersion = fetchLatestWaWebVersion) {
  const now = Date.now();
  if (cached && now - cached.at < FRESH_MS) return cached.version;
  if (now - failedAt < RETRY_AFTER_FAIL_MS) return cached?.version;
  if (!inflight) {
    inflight = (async () => {
      const r = await fetchVersion({ dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r && r.isLatest && Array.isArray(r.version)) {
        cached = { version: r.version, at: Date.now() };
        failedAt = 0;
      } else {
        failedAt = Date.now();
        log(`查询 WhatsApp 版本号失败，先用${cached ? '上次查到的' : '内置'}版本：${r?.error?.message || r?.error || '未知原因'}`);
      }
      return cached?.version;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

// 版本被 WhatsApp 拒绝（405）时清掉缓存，下次连接重新查；自检也用
export function resetVersionCache() { cached = null; failedAt = 0; inflight = null; }
