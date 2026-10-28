// 全 app 的颜色都从这里来：Radix UI Colors 3.0.0（npm 包 @radix-ui/colors）里用到的色阶，原样照抄，不改值。
// Radix 的分工：1–2 页面底色；3–5 控件底色（3 常态、4 悬停、5 按下）；6–8 边框（6 分割线、7 控件边框、8 悬停）；
// 9–10 实色（按钮、开关、角标，上面放白字）；11–12 文字（11 次要、12 主要）。-a 是半透明版，叠在有颜色的底上用。
// 只有 src/colors/ 里能写颜色值：CSS 用 radix.css 里的变量（npm run make:colors 从这个文件生成），JS 用 RADIX.hex('green', 9)。
// scripts/check-colors.js 核对：这里的值和 @radix-ui/colors 一致、生成的 CSS 是最新的、别处没有直接写的颜色。
(function (root) {
  'use strict';
  const light = {
    'slate': ['#fcfcfd', '#f9f9fb', '#f0f0f3', '#e8e8ec', '#e0e1e6', '#d9d9e0', '#cdced6', '#b9bbc6', '#8b8d98', '#80838d', '#60646c', '#1c2024'],
    'green': ['#fbfefc', '#f4fbf6', '#e6f6eb', '#d6f1df', '#c4e8d1', '#adddc0', '#8eceaa', '#5bb98b', '#30a46c', '#2b9a66', '#218358', '#193b2d'],
    'red': ['#fffcfc', '#fff7f7', '#feebec', '#ffdbdc', '#ffcdce', '#fdbdbe', '#f4a9aa', '#eb8e90', '#e5484d', '#dc3e42', '#ce2c31', '#641723'],
    'amber': ['#fefdfb', '#fefbe9', '#fff7c2', '#ffee9c', '#fbe577', '#f3d673', '#e9c162', '#e2a336', '#ffc53d', '#ffba18', '#ab6400', '#4f3422'],
    'blue': ['#fbfdff', '#f4faff', '#e6f4fe', '#d5efff', '#c2e5ff', '#acd8fc', '#8ec8f6', '#5eb1ef', '#0090ff', '#0588f0', '#0d74ce', '#113264'],
    'violet': ['#fdfcfe', '#faf8ff', '#f4f0fe', '#ebe4ff', '#e1d9ff', '#d4cafe', '#c2b5f5', '#aa99ec', '#6e56cf', '#654dc4', '#6550b9', '#2f265f'],
    'orange': ['#fefcfb', '#fff7ed', '#ffefd6', '#ffdfb5', '#ffd19a', '#ffc182', '#f5ae73', '#ec9455', '#f76b15', '#ef5f00', '#cc4e00', '#582d1d'],
    'crimson': ['#fffcfd', '#fef7f9', '#ffe9f0', '#fedce7', '#facedd', '#f3bed1', '#eaacc3', '#e093b2', '#e93d82', '#df3478', '#cb1d63', '#621639'],
    'brown': ['#fefdfc', '#fcf9f6', '#f6eee7', '#f0e4d9', '#ebdaca', '#e4cdb7', '#dcbc9f', '#cea37e', '#ad7f58', '#a07553', '#815e46', '#3e332e'],
    'cyan': ['#fafdfe', '#f2fafb', '#def7f9', '#caf1f6', '#b5e9f0', '#9ddde7', '#7dcedc', '#3db9cf', '#00a2c7', '#0797b9', '#107d98', '#0d3c48'],
    'grass': ['#fbfefb', '#f5fbf5', '#e9f6e9', '#daf1db', '#c9e8ca', '#b2ddb5', '#94ce9a', '#65ba74', '#46a758', '#3e9b4f', '#2a7e3b', '#203c25'],
    'indigo': ['#fdfdfe', '#f7f9ff', '#edf2fe', '#e1e9ff', '#d2deff', '#c1d0ff', '#abbdf9', '#8da4ef', '#3e63dd', '#3358d4', '#3a5bc7', '#1f2d5c'],
    'gold': ['#fdfdfc', '#faf9f2', '#f2f0e7', '#eae6db', '#e1dccf', '#d8d0bf', '#cbc0aa', '#b9a88d', '#978365', '#8c7a5e', '#71624b', '#3b352b'],
    'teal': ['#fafefd', '#f3fbf9', '#e0f8f3', '#ccf3ea', '#b8eae0', '#a1ded2', '#83cdc1', '#53b9ab', '#12a594', '#0d9b8a', '#008573', '#0d3d38'],
    'plum': ['#fefcff', '#fdf7fd', '#fbebfb', '#f7def8', '#f2d1f3', '#e9c2ec', '#deade3', '#cf91d8', '#ab4aba', '#a144af', '#953ea3', '#53195d'],
    'slate-a': ['#00005503', '#00005506', '#0000330f', '#00002d17', '#0009321f', '#00002f26', '#00062e32', '#00083046', '#00051d74', '#00071b7f', '#0007149f', '#000509e3'],
    'black-a': ['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.1)', 'rgba(0,0,0,0.15)', 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0.4)', 'rgba(0,0,0,0.5)', 'rgba(0,0,0,0.6)', 'rgba(0,0,0,0.7)', 'rgba(0,0,0,0.8)', 'rgba(0,0,0,0.9)', 'rgba(0,0,0,0.95)'],
    'white-a': ['rgba(255,255,255,0.05)', 'rgba(255,255,255,0.1)', 'rgba(255,255,255,0.15)', 'rgba(255,255,255,0.2)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0.5)', 'rgba(255,255,255,0.6)', 'rgba(255,255,255,0.7)', 'rgba(255,255,255,0.8)', 'rgba(255,255,255,0.9)', 'rgba(255,255,255,0.95)'],
  };
  const dark = {
    'slate': ['#111113', '#18191b', '#212225', '#272a2d', '#2e3135', '#363a3f', '#43484e', '#5a6169', '#696e77', '#777b84', '#b0b4ba', '#edeef0'],
    'green': ['#0e1512', '#121b17', '#132d21', '#113b29', '#174933', '#20573e', '#28684a', '#2f7c57', '#30a46c', '#33b074', '#3dd68c', '#b1f1cb'],
    'red': ['#191111', '#201314', '#3b1219', '#500f1c', '#611623', '#72232d', '#8c333a', '#b54548', '#e5484d', '#ec5d5e', '#ff9592', '#ffd1d9'],
    'amber': ['#16120c', '#1d180f', '#302008', '#3f2700', '#4d3000', '#5c3d05', '#714f19', '#8f6424', '#ffc53d', '#ffd60a', '#ffca16', '#ffe7b3'],
    'blue': ['#0d1520', '#111927', '#0d2847', '#003362', '#004074', '#104d87', '#205d9e', '#2870bd', '#0090ff', '#3b9eff', '#70b8ff', '#c2e6ff'],
    'violet': ['#14121f', '#1b1525', '#291f43', '#33255b', '#3c2e69', '#473876', '#56468b', '#6958ad', '#6e56cf', '#7d66d9', '#baa7ff', '#e2ddfe'],
    'orange': ['#17120e', '#1e160f', '#331e0b', '#462100', '#562800', '#66350c', '#7e451d', '#a35829', '#f76b15', '#ff801f', '#ffa057', '#ffe0c2'],
    'crimson': ['#191114', '#201318', '#381525', '#4d122f', '#5c1839', '#6d2545', '#873356', '#b0436e', '#e93d82', '#ee518a', '#ff92ad', '#fdd3e8'],
    'brown': ['#12110f', '#1c1816', '#28211d', '#322922', '#3e3128', '#4d3c2f', '#614a39', '#7c5f46', '#ad7f58', '#b88c67', '#dbb594', '#f2e1ca'],
    'cyan': ['#0b161a', '#101b20', '#082c36', '#003848', '#004558', '#045468', '#12677e', '#11809c', '#00a2c7', '#23afd0', '#4ccce6', '#b6ecf7'],
    'grass': ['#0e1511', '#141a15', '#1b2a1e', '#1d3a24', '#25482d', '#2d5736', '#366740', '#3e7949', '#46a758', '#53b365', '#71d083', '#c2f0c2'],
    'indigo': ['#11131f', '#141726', '#182449', '#1d2e62', '#253974', '#304384', '#3a4f97', '#435db1', '#3e63dd', '#5472e4', '#9eb1ff', '#d6e1ff'],
    'gold': ['#121211', '#1b1a17', '#24231f', '#2d2b26', '#38352e', '#444039', '#544f46', '#696256', '#978365', '#a39073', '#cbb99f', '#e8e2d9'],
    'teal': ['#0d1514', '#111c1b', '#0d2d2a', '#023b37', '#084843', '#145750', '#1c6961', '#207e73', '#12a594', '#0eb39e', '#0bd8b6', '#adf0dd'],
    'plum': ['#181118', '#201320', '#351a35', '#451d47', '#512454', '#5e3061', '#734079', '#92549c', '#ab4aba', '#b658c4', '#e796f3', '#f4d4f4'],
    'slate-a': ['#00000000', '#d8f4f609', '#ddeaf814', '#d3edf81d', '#d9edfe25', '#d6ebfd30', '#d9edff40', '#d9edff5d', '#dfebfd6d', '#e5edfd7b', '#f1f7feb5', '#fcfdffef'],
  };

  // 白：面板底色、实色按钮上的字（Radix 里实色 9 号配白字）
  const WHITE = '#ffffff';
  // 透明：Electron 透明窗口的底色
  const TRANSPARENT = '#00000000';

  // 账号颜色：6 种，取 9 号实色（slate 的 9 号太浅，用 11 号）
  const ACCOUNT = [['green', 9], ['violet', 9], ['orange', 9], ['blue', 9], ['crimson', 9], ['slate', 11]];
  const ACCOUNT_COLORS = ACCOUNT.map(([f, n]) => light[f][n - 1]);
  // 0.5.12 及以前的账号颜色（不是 Radix 的），读旧配置、团队后台旧数据时换成同位置的新颜色
  const LEGACY = { '#16a34a': 0, '#7c3aed': 1, '#ea580c': 2, '#2563eb': 3, '#db2777': 4, '#475569': 5 };
  // 通知弹窗里客户头像的底色（按客户名字挑一个），11 号上放白字
  const AVATAR_COLORS = ['brown', 'cyan', 'grass', 'crimson', 'indigo', 'gold', 'teal', 'plum'].map((f) => light[f][10]);

  const hex = (family, step) => {
    const v = light[family] && light[family][step - 1];
    if (!v) throw new Error(`没有这个颜色：${family} ${step}`);
    return v;
  };
  // 账号颜色归一：新颜色原样返回，旧颜色换成新的，别的返回 ''（调用方自己挑默认）
  function accountColor(c) {
    const k = String(c || '').toLowerCase();
    if (ACCOUNT_COLORS.includes(k)) return k;
    return Object.prototype.hasOwnProperty.call(LEGACY, k) ? ACCOUNT_COLORS[LEGACY[k]] : '';
  }
  // 账号的色系名（green / violet / …），认不出来时是 slate
  function accountFamily(c) {
    const i = ACCOUNT_COLORS.indexOf(accountColor(c));
    return i < 0 ? 'slate' : ACCOUNT[i][0];
  }

  const api = { light, dark, WHITE, TRANSPARENT, ACCOUNT, ACCOUNT_COLORS, LEGACY, AVATAR_COLORS, hex, accountColor, accountFamily };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RADIX = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
