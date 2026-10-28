// 侧栏「账号」旁 + 号弹出的菜单：添加账号、添加分组。main.js 和 scripts/check-add-menu.js 共用
function addMenuTemplate({ canGroup, addAccount, addGroup }) {
  return [
    { label: '添加账号', click: addAccount },
    { label: '添加分组', enabled: canGroup, click: addGroup },
  ];
}

module.exports = { addMenuTemplate };
