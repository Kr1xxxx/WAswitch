// 账号头像用的 emoji：一套固定挑过的图（Microsoft Fluent Emoji Flat，MIT 许可，见同目录 LICENSE），
// 打包进软件，Mac 和 Windows 显示一样，不用系统 emoji。图在 svg/<id>.svg，托盘菜单用 png/<id>.png。
// 主进程 require 这个文件；界面用 <script> 引入，读 window.EMOJI。
(function (root) {
  const LIST = [
    ['fox', '🦊', '狐狸'], ['panda', '🐼', '熊猫'], ['koala', '🐨', '考拉'], ['owl', '🦉', '猫头鹰'],
    ['penguin', '🐧', '企鹅'], ['dolphin', '🐬', '海豚'], ['whale', '🐳', '鲸鱼'], ['butterfly', '🦋', '蝴蝶'],
    ['turtle', '🐢', '乌龟'], ['octopus', '🐙', '章鱼'], ['lion', '🦁', '狮子'], ['tiger', '🐯', '老虎'],
    ['rabbit', '🐰', '兔子'], ['frog', '🐸', '青蛙'], ['unicorn', '🦄', '独角兽'], ['bee', '🐝', '蜜蜂'],
    ['sunflower', '🌻', '向日葵'], ['cactus', '🌵', '仙人掌'], ['clover', '🍀', '四叶草'], ['blossom', '🌸', '樱花'],
    ['tulip', '🌷', '郁金香'], ['maple', '🍁', '枫叶'], ['palm', '🌴', '棕榈树'], ['seedling', '🌱', '嫩芽'],
    ['lemon', '🍋', '柠檬'], ['cherries', '🍒', '樱桃'], ['strawberry', '🍓', '草莓'], ['watermelon', '🍉', '西瓜'],
    ['avocado', '🥑', '牛油果'], ['peach', '🍑', '桃子'], ['apple', '🍏', '青苹果'], ['grapes', '🍇', '葡萄'],
    ['pineapple', '🍍', '菠萝'], ['kiwi', '🥝', '猕猴桃'], ['doughnut', '🍩', '甜甜圈'], ['tea', '🧋', '奶茶'],
    ['rocket', '🚀', '火箭'], ['gem', '💎', '宝石'], ['sun', '☀️', '太阳'], ['moon', '🌙', '月亮'],
    ['rainbow', '🌈', '彩虹'], ['star', '🌟', '星星'], ['anchor', '⚓', '船锚'], ['compass', '🧭', '指南针'],
    ['sailboat', '⛵', '帆船'], ['bulb', '💡', '灯泡'], ['crown', '👑', '皇冠'], ['gift', '🎁', '礼物'],
  ].map(([id, char, name]) => ({ id, char, name }));
  const IDS = LIST.map((e) => e.id);
  const byId = new Map(LIST.map((e) => [e.id, e]));
  // 随机挑一个别的号还没用的；全用过了就在全部里随机
  function pick(used = [], rand = Math.random) {
    const taken = new Set(used);
    const free = IDS.filter((id) => !taken.has(id));
    const pool = free.length ? free : IDS;
    return pool[Math.floor(rand() * pool.length)];
  }
  const api = { LIST, IDS, get: (id) => byId.get(id) || null, valid: (id) => byId.has(id), pick };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EMOJI = api;
})(typeof window !== 'undefined' ? window : this);
