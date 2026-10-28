// 认出客户消息是哪种语言（本机算，不联网、不用额度）。
// 先看文字（阿拉伯字母、泰文、韩文、日文假名……），拉丁字母再按常用词猜。认不准返回 ''。
// 返回的名字和 translate.js 的 LANGS 一致。
// 主进程 require，软件界面（翻译页）用 <script> 加载成 window.LangDetect。
(function (root) {
const SCRIPTS = [
  [/[؀-ۿ]/g, '阿拉伯语'],
  [/[฀-๿]/g, '泰语'],
  [/[가-힯]/g, '韩语'],
  [/[぀-ヿ]/g, '日语'],
  [/[ऀ-ॿ]/g, '印地语'],
  [/[Ѐ-ӿ]/g, '俄语'],
];

// 每种语言 20~40 个最常见的短词（全部小写）
const WORDS = {
  英语: 'the and you is are to of for it this that what how can i we my your have do not please thanks thank hello hi yes no with price send ok will',
  印尼语: 'yang dan saya kak ini itu ada tidak bisa berapa ya apa mau sudah belum dengan untuk dari kirim harga barang terima kasih juga aja gak nggak',
  马来语: 'awak boleh tak nak encik cik sangat kat macam mana lah tu ni kau',
  西班牙语: 'el la los las de que y en es por para con una un no si hola gracias precio cuanto cuánto quiero tiene envío puede bien muy',
  葡萄牙语: 'o a os as de que e em é por para com uma um não sim olá obrigado obrigada preço quanto quero tem envio pode bem muito você',
  法语: 'le la les de des et en est pour avec une un je vous nous pas oui non bonjour merci prix combien veux avez livraison très',
  德语: 'der die das und ist nicht ich sie wir mit für ein eine ja nein hallo danke preis wie viel haben können bitte auch',
  意大利语: 'il lo la gli le di che e è per con una un non sì ciao grazie prezzo quanto voglio avete spedizione può bene molto',
  土耳其语: 've bir bu için ne mi mı var yok evet hayır merhaba teşekkürler fiyat kaç ben siz biz ile çok nasıl',
  越南语: 'và là có không của cho tôi bạn anh chị em này được một những giá bao nhiêu gửi cảm ơn vâng rồi',
  菲律宾语: 'ang ng sa na at ako ko mo po opo hindi oo salamat magkano ito iyan yung kayo namin padala presyo',
};
const DICT = Object.fromEntries(Object.entries(WORDS).map(([lang, w]) => [lang, new Set(w.split(' '))]));
const VIET = /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

function detectLang(text) {
  const t = String(text || '').slice(0, 2000);
  if (!t.trim()) return '';
  let letters = 0;
  for (const ch of t) if (/\p{L}/u.test(ch)) letters += 1;
  if (letters < 2) return '';
  // 中文：汉字多且没有假名
  const han = (t.match(/[一-鿿]/g) || []).length;
  for (const [re, lang] of SCRIPTS) {
    const n = (t.match(re) || []).length;
    if (n >= 2 && n / letters > 0.3) return lang;
  }
  if (han / letters > 0.5) return '中文';
  if (VIET.test(t)) return '越南语';
  const words = t.toLowerCase().normalize('NFC').match(/[\p{L}']+/gu) || [];
  if (words.length < 2) return '';
  let best = '';
  let bestN = 0;
  let second = 0;
  for (const [lang, set] of Object.entries(DICT)) {
    let n = 0;
    for (const w of words) if (set.has(w)) n += 1;
    if (n > bestN) { second = bestN; bestN = n; best = lang; } else if (n > second) second = n;
  }
  // 至少两个常用词，并且比第二名明显多，才算认出来
  if (bestN < 2 || bestN === second) return '';
  return best;
}

const api = { detectLang };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.LangDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
