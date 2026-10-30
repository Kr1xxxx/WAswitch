// 账号页面里右键弹出的菜单模板：拼写建议、图片、输入框、选中的文字。main.js 的 setupPageMenu 和 scripts/check-page-menu.js 共用
// p 是 Electron context-menu 事件的 params；act 是要做的事：replaceMisspelling(word)、addWord(word)、copyImage()、translate()
function pageMenuTemplate(p, act) {
  const items = [];
  if (p.misspelledWord) {
    for (const word of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: word, click: () => act.replaceMisspelling(word) });
    if (!items.length) items.push({ label: '没有拼写建议', enabled: false });
    items.push({ label: `把“${p.misspelledWord.slice(0, 30)}”加入词典`, click: () => act.addWord(p.misspelledWord) });
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    items.push(
      { label: '剪切', role: 'cut', enabled: p.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: p.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: p.editFlags.canPaste },
      { label: '全选', role: 'selectAll', enabled: p.editFlags.canSelectAll },
    );
    return items;
  }
  // 聊天里的图和点开后的大图；视频、还没加载出来的图不出这一项
  if (p.mediaType === 'image' && p.hasImageContents) items.push({ label: '复制图片', click: act.copyImage });
  if (p.selectionText) {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
    items.push({ label: '复制', role: 'copy' });
    // 和选中后出现的小按钮同一条路：在选区旁边弹出悬浮译文窗
    if (p.selectionText.trim()) items.push({ label: '翻译', click: act.translate });
  }
  return items;
}

module.exports = { pageMenuTemplate };
