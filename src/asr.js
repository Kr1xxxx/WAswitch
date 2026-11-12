// 语音转文字：切段、编码 wav、读回答。转写在来财的云端（/api/device/ai/transcribe，一次最长 30 秒）。
// 不依赖 electron，测试脚本可以直接 require。真正发请求的是 Translator.transcribe（translate.js），用团队登录的令牌。
// 音频只在内存里：16 kHz 单声道 16 位（界面进程解码好的，见 shell/voice.js）。
const RATE = 16000;
// 来财的 Worker 每次只有很少的 CPU 时间：一段别太大。15 秒以内整段发，更长的每段最长 14 秒
const ONE_MAX_S = 15;
const CHUNK_MAX_S = 14; // 要切时每段最长 14 秒
const CUT_WINDOW_S = 5; // 切点选在每段最后 5 秒里最安静的地方，免得把一个词切成两半
const QUIET_MS = 100;
const MAX_SECONDS = 300; // 一条语音最多转 5 分钟（约 22 段），更长的只转前 5 分钟

// 不超过 15 秒的整段发；更长的切成每段不超过 14 秒
function splitPcm(pcm, rate = RATE) {
  const total = Math.min(pcm.length, MAX_SECONDS * rate);
  const max = CHUNK_MAX_S * rate;
  const win = CUT_WINDOW_S * rate;
  const step = Math.max(1, Math.round((QUIET_MS / 1000) * rate));
  const cuts = [0];
  let at = 0;
  while (total - at > ONE_MAX_S * rate) { // 剩下的一段发得完就不再切
    // 最后 5 秒里按 100 毫秒一格找最安静的一格，从它中间切
    let best = at + max;
    let bestE = Infinity;
    for (let s = at + max - win; s + step <= at + max; s += step) {
      let e = 0;
      for (let i = s; i < s + step; i += 1) e += pcm[i] * pcm[i];
      if (e <= bestE) { bestE = e; best = s + Math.floor(step / 2); } // 一样安静取靠后的，段长一点
    }
    cuts.push(best);
    at = best;
  }
  cuts.push(total);
  const out = [];
  for (let i = 1; i < cuts.length; i += 1) if (cuts[i] > cuts[i - 1]) out.push(pcm.subarray(cuts[i - 1], cuts[i]));
  return out;
}

// 16 位单声道 PCM → wav 文件
function wavOf(pcm, rate = RATE) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 单声道
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// 来财的回答（{ ok, text }）→ 文字；没有就空
function textOf(raw) {
  try {
    const j = JSON.parse(raw);
    return typeof (j && j.text) === 'string' ? j.text.trim() : '';
  } catch { return ''; }
}

// 一段段转完拼起来。call(wav) -> 文字，失败时抛出 { kind, text }
async function transcribeChunks(chunks, call, rate = RATE) {
  const parts = [];
  for (const c of chunks) {
    const t = await call(wavOf(c, rate));
    if (t) parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// 时长显示成 0:23
const clock = (s) => { const n = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };

module.exports = { RATE, MAX_SECONDS, CHUNK_MAX_S, splitPcm, wavOf, textOf, transcribeChunks, clock };
