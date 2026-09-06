const $ = s => document.querySelector(s);
const state = { accounts: [], messages: [], editingAccountId: null };

const presets = {
  qq: { imapHost: 'imap.qq.com', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecurity: 'tls' },
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecurity: 'tls' },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecurity: 'starttls' },
  custom: { imapHost: '', imapPort: 993, imapSecurity: 'tls', smtpHost: '', smtpPort: 465, smtpSecurity: 'tls' }
};

function toast(message, bad = false) {
  const t = $('#toast'); t.textContent = message; t.className = bad ? 'show bad' : 'show';
  setTimeout(() => t.className = '', 4200);
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function handleOAuthResult() {
  const u = new URL(location.href);
  if (u.searchParams.get('oauth') !== 'microsoft') return;
  const ok = u.searchParams.get('status') === 'success';
  const message = u.searchParams.get('message');
  toast(ok ? 'Microsoft 邮箱授权成功' : `Microsoft 授权失败：${message || '未知错误'}`, !ok);
  u.searchParams.delete('oauth'); u.searchParams.delete('status'); u.searchParams.delete('message');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}

async function bootstrap() {
  handleOAuthResult();
  const s = await api('/api/session');
  if (!s.authenticated) { $('#loginView').classList.remove('hidden'); return; }
  $('#appView').classList.remove('hidden');
  await loadAccounts(); await loadInbox();
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#loginPassword').value }) });
    $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
    await loadAccounts(); await loadInbox();
  } catch (e) { toast(e.message, true); }
});

function closeAccountMenus(except = null) {
  document.querySelectorAll('.account-menu.open').forEach(menu => {
    if (menu !== except) menu.classList.remove('open');
  });
}

document.addEventListener('click', () => closeAccountMenus());

async function testAccount(a) {
  closeAccountMenus();
  toast(`正在测试 ${a.label}…`);
  try {
    await api(`/api/accounts/${a.id}/test`, { method: 'POST' });
    toast(`${a.label} 连接成功`);
  } catch (err) {
    toast(`${a.label} 连接失败：${err.message}`, true);
  }
  await loadAccounts();
}

async function deleteAccount(a) {
  closeAccountMenus();
  if (!confirm(`删除 ${a.email} 的云端配置？不会删除邮箱服务器里的邮件。`)) return;
  await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
  toast('邮箱配置已删除');
  await loadAccounts(); await loadInbox();
}

function prepareAddDialog() {
  state.editingAccountId = null;
  $('#accountForm').reset();
  $('#provider').disabled = false;
  $('#email').readOnly = false;
  $('#username').dataset.touched = '';
  $('#mailPassword').placeholder = '';
  $('#accountDialog .modal-head h3').textContent = '添加邮箱';
  $('#accountDialog .modal-head p').textContent = 'QQ/Gmail/通用邮箱使用密码或授权码；Outlook / Microsoft 365 使用 Microsoft OAuth。';
  $('#provider').value = 'qq';
  applyPreset('qq');
  $('#saveAccountBtn').textContent = '保存邮箱';
}

function openEditAccount(a) {
  closeAccountMenus();
  state.editingAccountId = a.id;
  $('#accountForm').reset();
  $('#provider').value = a.provider || 'custom';
  $('#provider').disabled = true;
  $('#label').value = a.label || '';
  $('#email').value = a.email || '';
  $('#username').value = a.username || '';
  $('#imapHost').value = a.imapHost || '';
  $('#imapPort').value = a.imapPort || 993;
  $('#imapSecurity').value = a.imapSecurity || 'tls';
  $('#smtpHost').value = a.smtpHost || '';
  $('#smtpPort').value = a.smtpPort || 465;
  $('#smtpSecurity').value = a.smtpSecurity || 'tls';
  $('#mailPassword').value = '';
  $('#mailPassword').placeholder = '留空则保持现有密码 / 授权码';
  $('#accountDialog .modal-head h3').textContent = '编辑邮箱设置';

  if (a.authType === 'oauth_microsoft') {
    $('#credentialFields').classList.add('hidden');
    $('#microsoftOauthFields').classList.add('hidden');
    $('#saveAccountBtn').classList.remove('hidden');
    $('#saveAccountBtn').textContent = '保存修改';
    $('#email').readOnly = true;
    $('#accountDialog .modal-head p').textContent = 'Microsoft OAuth 账户当前可修改显示名称；邮箱地址和认证信息由 Microsoft 授权维护。';
  } else {
    $('#credentialFields').classList.remove('hidden');
    $('#microsoftOauthFields').classList.add('hidden');
    $('#saveAccountBtn').classList.remove('hidden');
    $('#saveAccountBtn').textContent = '保存修改';
    $('#email').readOnly = false;
    $('#accountDialog .modal-head p').textContent = '可修改邮箱地址、服务器、用户名；密码留空则保持现有凭据。';
    for (const id of ['username', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort']) $(`#${id}`).required = true;
    $('#mailPassword').required = false;
  }
  $('#accountDialog').showModal();
}

async function loadAccounts() {
  const data = await api('/api/accounts'); state.accounts = data.accounts;
  const list = $('#accountList'); list.innerHTML = '';
  const select = $('#composeAccount'); select.innerHTML = '';
  for (const a of state.accounts) {
    const item = document.createElement('div'); item.className = 'account-item';
    const oauthBadge = a.authType === 'oauth_microsoft' ? ' · OAuth' : '';
    item.innerHTML = `
      <span class="dot ${a.lastError ? 'error' : ''}"></span>
      <div class="account-info"><strong>${esc(a.label)}</strong><small>${esc(a.email)}${oauthBadge}</small></div>
      <div class="account-actions">
        <button class="account-menu-btn" type="button" title="更多操作" aria-label="${esc(a.label)} 更多操作">•••</button>
        <div class="account-menu" role="menu">
          <button type="button" data-action="edit" role="menuitem">编辑设置</button>
          <button type="button" data-action="test" role="menuitem">测试连接</button>
          <div class="menu-separator"></div>
          <button type="button" class="danger" data-action="delete" role="menuitem">删除邮箱</button>
        </div>
      </div>`;

    const menu = item.querySelector('.account-menu');
    item.querySelector('.account-menu-btn').onclick = e => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains('open');
      closeAccountMenus(menu);
      menu.classList.toggle('open', willOpen);
    };
    menu.onclick = e => e.stopPropagation();
    menu.querySelector('[data-action="edit"]').onclick = () => openEditAccount(a);
    menu.querySelector('[data-action="test"]').onclick = () => testAccount(a);
    menu.querySelector('[data-action="delete"]').onclick = () => deleteAccount(a);

    list.appendChild(item);
    const opt = document.createElement('option'); opt.value = a.id; opt.textContent = `${a.label} · ${a.email}`; select.appendChild(opt);
  }
}

async function loadInbox() {
  $('#statusText').textContent = state.accounts.length ? `正在连接 ${state.accounts.length} 个邮箱…` : '尚未添加邮箱';
  $('#messageList').innerHTML = '<div class="loading">正在读取各邮箱的最近邮件…</div>';
  if (!state.accounts.length) { $('#messageList').innerHTML = ''; $('#emptyState').classList.remove('hidden'); return; }
  try {
    const data = await api('/api/inbox?limit=60'); state.messages = data.messages;
    $('#statusText').textContent = `${data.messages.length} 封最近邮件 · ${state.accounts.length} 个账户`;
    const banner = $('#failureBanner');
    if (data.failures?.length) {
      banner.textContent = `${data.failures.length} 个邮箱连接失败：` + data.failures.map(f => state.accounts.find(a => a.id === f.accountId)?.label || f.accountId).join('、');
      banner.classList.remove('hidden');
    } else banner.classList.add('hidden');
    renderMessages();
  } catch (e) { $('#messageList').innerHTML = ''; toast(e.message, true); }
}

function renderMessages() {
  const list = $('#messageList'); list.innerHTML = '';
  $('#emptyState').classList.toggle('hidden', !!state.messages.length);
  for (const m of state.messages) {
    const row = document.createElement('button'); row.className = `message-row ${m.flags?.includes('\\Seen') ? '' : 'unread'}`;
    row.innerHTML = `<div class="avatar">${esc(initials(m.from))}</div><div class="message-main"><div class="message-line"><strong>${esc(displayFrom(m.from))}</strong><time>${fmtDate(m.date)}</time></div><div class="subject">${esc(m.subject || '(No subject)')}</div><div class="account-pill">${esc(m.accountLabel)}</div></div>`;
    row.onclick = () => openMessage(m); list.appendChild(row);
  }
}

async function openMessage(m) {
  $('#reader').classList.remove('hidden'); $('#readerSubject').textContent = '载入中…'; $('#readerBody').textContent = '';
  try {
    const data = await api(`/api/accounts/${m.accountId}/messages/${m.uid}`); const x = data.message;
    $('#readerAccount').textContent = m.accountLabel; $('#readerSubject').textContent = x.subject; $('#readerFrom').textContent = x.from;
    $('#readerDate').textContent = fmtDateLong(x.date); $('#readerTo').textContent = `To: ${x.to || '—'}`;
    $('#readerBody').textContent = x.text || '[当前 MVP 暂不渲染仅 HTML/复杂嵌套 MIME 邮件的原始内容]';
  } catch (e) { $('#readerSubject').textContent = '读取失败'; $('#readerBody').textContent = e.message; }
}

$('#closeReader').onclick = () => $('#reader').classList.add('hidden');
$('#refreshBtn').onclick = async () => { await loadAccounts(); await loadInbox(); };
$('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('#addAccountBtn').onclick = () => { prepareAddDialog(); $('#accountDialog').showModal(); };
document.querySelectorAll('.close-dialog').forEach(b => b.onclick = () => { state.editingAccountId = null; $('#accountDialog').close(); });
$('#provider').onchange = e => applyPreset(e.target.value);
$('#email').oninput = e => { if (!$('#username').dataset.touched) $('#username').value = e.target.value; };
$('#username').oninput = () => $('#username').dataset.touched = '1';

function applyPreset(name) {
  const p = presets[name]; for (const [k, v] of Object.entries(p)) $(`#${k}`).value = v;
  const isMicrosoft = name === 'outlook';
  $('#credentialFields').classList.toggle('hidden', isMicrosoft);
  $('#microsoftOauthFields').classList.toggle('hidden', !isMicrosoft);
  $('#saveAccountBtn').classList.toggle('hidden', isMicrosoft);
  for (const id of ['username', 'mailPassword', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort']) {
    $(`#${id}`).required = !isMicrosoft;
  }
}

$('#microsoftOAuthBtn').onclick = async () => {
  const label = $('#label').value.trim();
  const email = $('#email').value.trim();
  if (!label || !email) { toast('请先填写显示名称和 Microsoft 邮箱地址', true); return; }
  const b = $('#microsoftOAuthBtn'); b.disabled = true; b.textContent = '正在前往 Microsoft…';
  try {
    const data = await api('/api/oauth/microsoft/start', { method: 'POST', body: JSON.stringify({ label, email }) });
    location.href = data.url;
  } catch (err) {
    toast(err.message, true); b.disabled = false; b.textContent = '使用 Microsoft 登录并授权';
  }
};

$('#accountForm').addEventListener('submit', async e => {
  e.preventDefault();
  const editing = state.editingAccountId ? state.accounts.find(a => a.id === state.editingAccountId) : null;
  const b = $('#saveAccountBtn'); b.disabled = true; b.textContent = editing ? '保存中…' : '保存中…';

  if (!editing && $('#provider').value === 'outlook') { b.disabled = false; return; }

  const body = {
    provider: $('#provider').value, label: $('#label').value, email: $('#email').value, username: $('#username').value,
    password: $('#mailPassword').value, imapHost: $('#imapHost').value, imapPort: Number($('#imapPort').value), imapSecurity: $('#imapSecurity').value,
    smtpHost: $('#smtpHost').value, smtpPort: Number($('#smtpPort').value), smtpSecurity: $('#smtpSecurity').value
  };

  try {
    if (editing) {
      const updated = await api(`/api/accounts/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      $('#accountDialog').close(); state.editingAccountId = null;
      toast('邮箱设置已更新');
      await loadAccounts();
      try { await api(`/api/accounts/${updated.account.id}/test`, { method: 'POST' }); toast('设置已保存，连接测试成功'); }
      catch (err) { toast(`设置已保存，但连接测试失败：${err.message}`, true); }
      await loadAccounts(); await loadInbox();
    } else {
      const created = await api('/api/accounts', { method: 'POST', body: JSON.stringify(body) });
      $('#accountDialog').close(); $('#accountForm').reset(); $('#username').dataset.touched = ''; $('#provider').value = 'qq'; applyPreset('qq');
      toast('邮箱已保存，正在测试 IMAP…'); await loadAccounts();
      try { await api(`/api/accounts/${created.account.id}/test`, { method: 'POST' }); toast('连接成功'); } catch (err) { toast(`已保存，但连接测试失败：${err.message}`, true); }
      await loadAccounts(); await loadInbox();
    }
  } catch (err) { toast(err.message, true); }
  finally { b.disabled = false; b.textContent = state.editingAccountId ? '保存修改' : '保存邮箱'; }
});

$('#composeBtn').onclick = () => state.accounts.length ? $('#composeDialog').showModal() : toast('请先添加邮箱', true);
document.querySelectorAll('.close-compose').forEach(b => b.onclick = () => $('#composeDialog').close());
$('#composeForm').addEventListener('submit', async e => {
  e.preventDefault(); const b = $('#sendBtn'); b.disabled = true; b.textContent = '发送中…';
  try {
    await api('/api/send', { method: 'POST', body: JSON.stringify({ accountId: $('#composeAccount').value, to: $('#composeTo').value, subject: $('#composeSubject').value, text: $('#composeText').value }) });
    $('#composeDialog').close(); $('#composeForm').reset(); toast('邮件已发送');
  } catch (err) { toast(err.message, true); }
  finally { b.disabled = false; b.textContent = '发送'; }
});

$('#mobileMenu').onclick = () => $('.sidebar').classList.toggle('open');
function esc(s='') { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function displayFrom(s='') { return s.replace(/<[^>]+>/g, '').replace(/^"|"$/g, '').trim() || s; }
function initials(s='') { const x = displayFrom(s); return (x[0] || '?').toUpperCase(); }
function fmtDate(s) { const d = new Date(s); if (isNaN(d)) return ''; const now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : d.toLocaleDateString([], {month:'short',day:'numeric'}); }
function fmtDateLong(s) { const d = new Date(s); return isNaN(d) ? s : d.toLocaleString(); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
prepareAddDialog();
bootstrap().catch(e => toast(e.message, true));
