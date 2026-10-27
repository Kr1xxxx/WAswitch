// MCP 修改客户资料（update_customer）在主进程这边用的接口：读、找、改、撤销、删除客户。
// 只能看到、改到没停用的账号名下的客户（和客户名单界面一样）。改完调用 onChange 让界面刷新客户名单。
// AI 操作记录和撤销的判断在 src/mcp/customer-edit.js（单独下载的 MCP 模块里）。
//
// deps:
//   store()          -> Records('customers')（软件启动后才有）
//   findAcc(id)      -> 没停用的账号 | undefined
//   parked(customer) -> 这个客户的账号停用了
//   onChange()
const digits = (p) => String(p || '').replace(/\D/g, '');
const copy = (c) => (c ? { id: c.id, accountId: c.accountId, name: c.name, phone: c.phone, tags: [...c.tags], note: c.note, followUpAt: c.followUpAt, reminded: c.reminded } : null);

function customerHooks({ store, findAcc, parked, onChange = () => {} }) {
  const visible = (c) => !!c && !parked(c) && (!c.accountId || !!findAcc(c.accountId));
  const get = (id) => {
    const s = store();
    const c = s && typeof id === 'string' ? s.get(id) : null;
    return visible(c) ? c : null;
  };
  return {
    customerGet: (id) => copy(get(id)),
    customerFind: (accountId, phone) => {
      const s = store();
      const d = digits(phone);
      if (!s || !d || !findAcc(accountId)) return null;
      return copy(s.list().find((c) => c.accountId === accountId && digits(c.phone) === d && visible(c)));
    },
    // 带 id：只改给出的字段（语言等其他字段保持不变）；不带 id：在 accountId 名下新建
    customerSave: (data) => {
      const s = store();
      if (!s || !data) return null;
      let rec;
      if (data.id) {
        const old = get(data.id);
        if (!old) return null;
        rec = s.upsert({ ...old, ...data, id: old.id, accountId: old.accountId });
      } else {
        if (!findAcc(data.accountId)) return null;
        rec = s.upsert({ ...data, id: undefined });
      }
      if (rec) onChange();
      return copy(rec);
    },
    // 撤销：改回给出的字段；reminded 是布尔值时一起还原“提醒过没有”
    customerRestore: (id, fields, reminded) => {
      const old = get(id);
      if (!old) return false;
      const rec = store().upsert({ ...old, ...fields, id: old.id, accountId: old.accountId });
      if (!rec) return false;
      if (typeof reminded === 'boolean') store().patch(id, { reminded });
      onChange();
      return true;
    },
    customerRemove: (id) => {
      if (!get(id) || !store().remove(id)) return false;
      onChange();
      return true;
    },
  };
}

module.exports = { customerHooks };
