// 一层工具：账号管理。只用主进程已有的数据（账号列表、页面标题里的未读数、加载状态），
// 不读取 WhatsApp 页面内容，也不往页面注入脚本。
const { z } = require('zod');

const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

const STATUS_NOTE = 'status 含义：not_loaded 页面还没打开；loading 正在加载；ready 页面已加载；error 加载失败，原因见 problem。login 是否登录：logged_in 已登录，needs_qr 停在扫码页需要重新扫码，unknown 还没检测到（每 3 分钟只读检测一次，不读聊天内容）。';

// hooks 由 main.js 提供：
//   listAccounts() -> [{ id, name, active, unread, muted, status, login, problem }]
//   regions() -> [{ key, label }]
//   activate(id)
//   openAddAccount({ name, region })  打开预填的“添加账号”窗口，由人确认后保存
//   renameAccount(id, name) -> boolean
//   removeAccount(id, { timeoutMs }) -> 'removed' | 'cancelled' | 'busy' | 'not_found'
function registerAccountTools(server, hooks, { confirmTimeoutMs }) {
  const find = (id) => hooks.listAccounts().find((a) => a.id === id);
  const idArg = z.string().min(1).describe('账号 id，来自 list_accounts');

  server.registerTool('list_accounts', {
    title: '列出账号',
    description: `列出 WAswitch 里所有 WhatsApp 账号：id、名称、是否当前显示、未读对话数、是否静音、页面状态。${STATUS_NOTE}`,
    annotations: { readOnlyHint: true },
  }, async () => text(hooks.listAccounts()));

  server.registerTool('get_unread_counts', {
    title: '未读数汇总',
    description: '各账号的未读对话数和总数。数字来自页面标题，是“有未读消息的对话数”，不是消息条数。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const list = hooks.listAccounts().map(({ id, name, unread, muted }) => ({ id, name, unread, muted }));
    return text({ total: list.reduce((s, a) => s + a.unread, 0), accounts: list });
  });

  server.registerTool('get_connection_status', {
    title: '连接状态',
    description: `各账号页面的状态和错误说明（例如代理连不上）。${STATUS_NOTE}`,
    inputSchema: { id: idArg.optional() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const list = hooks.listAccounts().map(({ id: i, name, status, login, problem }) => ({ id: i, name, status, login, problem }));
    if (!id) return text(list);
    const one = list.find((a) => a.id === id);
    return one ? text(one) : fail(`没有 id 为 ${id} 的账号`);
  });

  server.registerTool('switch_account', {
    title: '切换账号',
    description: '在 WAswitch 窗口里切换到指定账号（不抢键盘焦点，窗口在托盘里时会显示出来但不激活）。如果用户正在 WAswitch 里打字或编辑账号，不会直接切，而是在窗口顶部问用户，这时返回 pending: true，切不切由用户决定。',
    inputSchema: { id: idArg },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ id }) => {
    if (!find(id)) return fail(`没有 id 为 ${id} 的账号`);
    if (hooks.activate(id) === 'pending') return text({ ok: true, pending: true, next: '用户正在使用 WAswitch，已在窗口顶部询问是否切换。不要重复调用。' });
    return text({ ok: true, active: id });
  });

  server.registerTool('add_account', {
    title: '添加账号',
    description: '在 WAswitch 里打开“添加账号”窗口，并预填名称和地区（用户正在打字或编辑时，先在窗口顶部询问，返回 pending: true）。不会直接创建账号：用户要在窗口里确认代理并点保存，之后用手机扫码登录。这样新号不会在没设代理的情况下先联网。保存后可以用 list_accounts 查到新账号。',
    inputSchema: {
      name: z.string().trim().min(1).max(40).optional().describe('预填的账号名称，不填则自动命名'),
      region: z.enum(hooks.regions().map((r) => r.key)).optional()
        .describe(`预填的地区（决定时区和语言），默认 auto。可选：${hooks.regions().map((r) => `${r.key}=${r.label}`).join('，')}`),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ name, region }) => {
    if (hooks.openAddAccount({ name, region: region || 'auto' }) === 'pending') {
      return text({ ok: true, created: false, pending: true, next: '用户正在使用 WAswitch，已在窗口顶部询问是否打开“添加账号”窗口。不要重复调用。' });
    }
    return text({ ok: true, created: false, next: '已在 WAswitch 里打开“添加账号”窗口。请用户确认名称、代理和地区后点保存，再用手机 WhatsApp 扫码登录。' });
  });

  server.registerTool('rename_account', {
    title: '改名',
    description: '修改账号在 WAswitch 里显示的名称（不影响 WhatsApp 资料）。',
    inputSchema: { id: idArg, name: z.string().trim().min(1).max(40) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ id, name }) => (hooks.renameAccount(id, name) ? text({ ok: true, id, name }) : fail(`没有 id 为 ${id} 的账号`)));

  server.registerTool('remove_account', {
    title: '删除账号',
    description: `删除账号并清除它在本机的登录数据，之后要重新扫码。WAswitch 会弹窗让用户确认，${Math.round(confirmTimeoutMs / 1000)} 秒内没人确认视为取消。`,
    inputSchema: { id: idArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ id }) => {
    const result = await hooks.removeAccount(id, { timeoutMs: confirmTimeoutMs });
    if (result === 'removed') return text({ ok: true, removed: id });
    if (result === 'not_found') return fail(`没有 id 为 ${id} 的账号`);
    if (result === 'busy') return fail('已经有一个删除确认框在等用户处理，请稍后再试。');
    return fail('用户没有确认删除（取消或超时），账号保留。');
  });
}

module.exports = { registerAccountTools };
