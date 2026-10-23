const id = new URLSearchParams(location.search).get('id') || '';
const $ = (s) => document.getElementById(s);
let hasSavedPassword = false;

// 只有 http 代理带用户名时才需要密码
function updatePasswordRow() {
  const v = $('proxy').value.trim();
  const needs = /^https?:\/\/[^/@]+@/i.test(v);
  $('passwordRow').hidden = !needs;
  $('passwordHint').textContent = hasSavedPassword
    ? '已保存密码。留空表示不修改。密码用系统钥匙串加密保存在本机。'
    : '密码会用系统钥匙串加密后保存在本机。';
}

window.editor.load(id).then((data) => {
  $('title').textContent = data.isNew ? '添加账号' : '编辑账号';
  $('name').value = data.name;
  $('proxy').value = data.proxy;
  hasSavedPassword = data.hasPassword;
  for (const r of data.regions) {
    const opt = document.createElement('option');
    opt.value = r.key;
    opt.textContent = r.label;
    $('region').appendChild(opt);
  }
  $('region').value = data.region;
  updatePasswordRow();
  $('name').focus();
});

$('proxy').addEventListener('input', () => {
  $('testResult').textContent = '';
  updatePasswordRow();
});

$('test').onclick = async () => {
  const out = $('testResult');
  out.className = '';
  out.textContent = '正在测试…';
  $('test').disabled = true;
  const res = await window.editor.test({ id, proxy: $('proxy').value, password: $('password').value });
  $('test').disabled = false;
  if (res.error) {
    out.className = 'bad';
    out.textContent = res.error;
    return;
  }
  out.className = 'ok';
  const place = [res.country, res.city].filter(Boolean).join(' · ');
  out.textContent = `连接成功：出口 IP ${res.ip}（${place}），时区 ${res.timezone}，耗时 ${res.ms} 毫秒。`;
  if (res.region) {
    $('region').value = res.region;
    out.textContent += ' 已自动选好地区。';
  } else {
    out.textContent += ' 没有匹配的地区预设，请手动选择最接近的。';
  }
};

$('cancel').onclick = () => window.close();
$('save').onclick = async () => {
  const name = $('name').value.trim();
  if (!name) { $('error').textContent = '请填写名称'; return; }
  $('save').disabled = true;
  const res = await window.editor.save({
    id, name, proxy: $('proxy').value, password: $('password').value, region: $('region').value,
  });
  $('save').disabled = false;
  if (res && res.error) $('error').textContent = res.error;
};
