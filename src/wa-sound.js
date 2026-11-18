// 新消息只响一种提示音：WAswitch 弹窗自己的，和网页号里 WhatsApp 网页版自己的，不能一起响（shen 2026-11-18）。
//
// 不往 WhatsApp 页面注入：用 Electron 的 webContents.setAudioMuted 把这个号的整页静音。
// - 用户正看着这个号（WAswitch 在前台、开着这个号）：WAswitch 不弹也不响（notify.js 的 looking），
//   页面不静音，WhatsApp 自己响。听语音、看视频、打电话也都在这时候
// - 没看着这个号：WAswitch 的弹窗提示音开着就静音页面，只响 WAswitch 的；
//   勿扰开着、这个号在 WAswitch 里关了提醒，也静音（WAswitch 不响，WhatsApp 也别响）；
//   这些都没有时（弹窗提示音关了）才让 WhatsApp 自己响
// - 切走的时候页面正在出声（语音还没放完）先不静音，等声音停了再静音（页面的 audio-state-changed 会再同步一次）

function wantMute({ looking, sound, dnd, muted }) {
  return !looking && (sound !== false || !!dnd || !!muted);
}

// 把一个页面设成该有的样子
function apply(wc, mute) {
  if (!wc || wc.isDestroyed()) return;
  if (wc.isAudioMuted() === mute) return;
  if (mute && wc.isCurrentlyAudible()) return;
  wc.setAudioMuted(mute);
}

module.exports = { wantMute, apply };
