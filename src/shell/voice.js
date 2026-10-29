// 语音转文字前的解码：主进程把下载好的客户语音（OGG/Opus）发过来，这里解码成 16 kHz 单声道 16 位再还回去。
// 主进程没有 Opus 解码器，Chromium 自带，不加依赖。音频只在内存里。
(function () {
  const RATE = 16000;
  const MAX_S = 301; // 只转前 5 分钟（见 asr.js），多留 1 秒
  async function decode(bytes) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    // 解码时自动重采样成这个环境的采样率（16 kHz）
    const buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(ab);
    const n = Math.min(buf.length, MAX_S * RATE);
    const pcm = new Int16Array(n);
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c += 1) chs.push(buf.getChannelData(c));
    // 5 分钟的语音一次转完要 80 毫秒左右：每 4 秒音频让出一下，界面不卡
    const STEP = RATE * 4;
    for (let at = 0; at < n; at += STEP) {
      if (at) await new Promise((r) => setTimeout(r, 0));
      const end = Math.min(n, at + STEP);
      for (let i = at; i < end; i += 1) {
        let v = 0;
        for (const ch of chs) v += ch[i];
        v /= chs.length || 1;
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      }
    }
    return pcm;
  }
  if (!window.wa || !window.wa.onVoiceDecode) return;
  window.wa.onVoiceDecode(async ({ n, bytes } = {}) => {
    try { window.wa.voiceDecoded(n, { pcm: await decode(bytes) }); } catch { window.wa.voiceDecoded(n, { error: true }); }
  });
}());
