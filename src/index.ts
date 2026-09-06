import type { Env, MailAccountInput, OAuthStateRow, ProxyConfig, ShadowsocksMethod, StoredAccount } from './types';
import { createSession, decryptCredential, encryptCredential, getCookie, verifyAdminPassword, verifySession } from './lib/crypto';
import { withImap, type ImapConfig } from './lib/imap';
import { parseMessage } from './lib/mime';
import { exchangeMicrosoftCode, microsoftAccessToken, microsoftAuthorizeUrl } from './lib/oauth';
import { sendMail, type SmtpConfig } from './lib/smtp';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const SS_METHODS: ShadowsocksMethod[] = [
  'aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305', '2022-blake3-chacha8-poly1305'
];

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(JSON_HEADERS);
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function errorMessage(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.replace(/LOGIN\s+"[^"]*"\s+"[^"]*"/gi, 'LOGIN *** ***').slice(0, 600);
}

function validHost(host: string): boolean {
  return /^[a-z0-9.-]+$/i.test(host) && host.length <= 253 && !/^(localhost|0\.0\.0\.0|127\.)/i.test(host);
}
function validEmail(email: string): boolean { return /^\S+@\S+\.\S+$/.test(email || ''); }

function validateProxy(input: MailAccountInput, existing?: StoredAccount): string | null {
  const mode = input.proxyMode || 'direct';
  if (!['direct', 'socks5', 'shadowsocks'].includes(mode)) return 'Invalid proxy mode';
  if (mode === 'direct') return null;
  if (!validHost(input.proxyHost || '')) return mode === 'socks5' ? 'A valid SOCKS5 proxy hostname is required' : 'A valid Shadowsocks server hostname is required';
  if (!Number.isInteger(input.proxyPort) || Number(input.proxyPort) < 1 || Number(input.proxyPort) > 65535) return `Invalid ${mode === 'socks5' ? 'SOCKS5' : 'Shadowsocks'} port`;
  if (mode === 'shadowsocks') {
    if (!input.proxyMethod || !SS_METHODS.includes(input.proxyMethod)) return 'A supported Shadowsocks encryption method is required';
    const canReuse = existing?.proxy_mode === 'shadowsocks' && !!existing.proxy_password_ciphertext;
    if (!input.proxyPassword && !canReuse) return 'Shadowsocks password / PSK is required';
  }
  return null;
}

function validateAccount(input: MailAccountInput, requirePassword = true, existing?: StoredAccount): string | null {
  if (!input.label?.trim()) return 'Label is required';
  if (!validEmail(input.email)) return 'A valid email address is required';
  if (!validHost(input.imapHost || '') || !validHost(input.smtpHost || '')) return 'Invalid mail server hostname';
  for (const p of [input.imapPort, input.smtpPort]) if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Invalid port';
  if (input.smtpPort === 25) return 'SMTP port 25 is blocked by Cloudflare Workers; use 465 or 587';
  if (!['tls', 'starttls'].includes(input.imapSecurity)) return 'IMAP must use TLS or STARTTLS';
  if (!['tls', 'starttls'].includes(input.smtpSecurity)) return 'SMTP must use TLS or STARTTLS';
  if (!input.username || (requirePassword && !input.password)) return requirePassword ? 'Username and password/app password are required' : 'Username is required';
  return validateProxy(input, existing);
}

function publicAccount(a: StoredAccount) {
  return {
    id: a.id, label: a.label, email: a.email, provider: a.provider, authType: a.auth_type || 'password',
    imapHost: a.imap_host, imapPort: a.imap_port, imapSecurity: a.imap_security,
    smtpHost: a.smtp_host, smtpPort: a.smtp_port, smtpSecurity: a.smtp_security,
    username: a.username,
    proxyMode: a.proxy_mode || 'direct', proxyHost: a.proxy_host || '', proxyPort: a.proxy_port || 1080,
    proxyUsername: a.proxy_username || '', proxyMethod: a.proxy_method || '', hasProxyPassword: !!a.proxy_password_ciphertext,
    createdAt: a.created_at, updatedAt: a.updated_at, lastOkAt: a.last_ok_at, lastError: a.last_error
  };
}

async function getAccount(env: Env, id: string): Promise<StoredAccount | null> {
  return await env.DB.prepare('SELECT * FROM mail_accounts WHERE id = ?').bind(id).first<StoredAccount>();
}
async function accountSecret(env: Env, account: StoredAccount): Promise<string> {
  return decryptCredential(env.CREDENTIAL_KEY, account.credential_ciphertext, account.credential_iv);
}

async function proxyCfg(env: Env, account: StoredAccount): Promise<ProxyConfig | undefined> {
  const mode = account.proxy_mode || 'direct';
  if (mode === 'direct') return undefined;
  let password = '';
  if (account.proxy_password_ciphertext && account.proxy_password_iv) {
    password = await decryptCredential(env.CREDENTIAL_KEY, account.proxy_password_ciphertext, account.proxy_password_iv);
  }
  if (mode === 'socks5') {
    return { mode, host: account.proxy_host || undefined, port: account.proxy_port || undefined, username: account.proxy_username || undefined, password: password || undefined };
  }
  return { mode: 'shadowsocks', host: account.proxy_host || undefined, port: account.proxy_port || undefined, password: password || undefined, ssMethod: account.proxy_method || undefined };
}

async function imapCfg(env: Env, account: StoredAccount): Promise<ImapConfig> {
  const proxy = await proxyCfg(env, account);
  if (account.auth_type === 'oauth_microsoft') {
    const accessToken = await microsoftAccessToken(env, account);
    return { host: account.imap_host, port: account.imap_port, security: account.imap_security, username: account.username, accessToken, authType: 'xoauth2', proxy };
  }
  const password = await accountSecret(env, account);
  return { host: account.imap_host, port: account.imap_port, security: account.imap_security, username: account.username, password, authType: 'password', proxy };
}

async function smtpCfg(env: Env, account: StoredAccount): Promise<SmtpConfig> {
  const proxy = await proxyCfg(env, account);
  if (account.auth_type === 'oauth_microsoft') {
    const accessToken = await microsoftAccessToken(env, account);
    return { host: account.smtp_host, port: account.smtp_port, security: account.smtp_security, username: account.username, accessToken, authType: 'xoauth2', from: account.email, proxy };
  }
  const password = await accountSecret(env, account);
  return { host: account.smtp_host, port: account.smtp_port, security: account.smtp_security, username: account.username, password, authType: 'password', from: account.email, proxy };
}

async function proxyValues(env: Env, input: MailAccountInput, existing?: StoredAccount) {
  const mode = input.proxyMode || 'direct';
  if (mode === 'direct') return { mode: 'direct', host: null, port: null, username: null, method: null, ciphertext: null, iv: null };

  const canReuse = existing?.proxy_mode === mode && !!existing.proxy_password_ciphertext;
  let ciphertext = canReuse ? existing!.proxy_password_ciphertext : null;
  let iv = canReuse ? existing!.proxy_password_iv : null;
  if (input.proxyPassword) {
    const encrypted = await encryptCredential(env.CREDENTIAL_KEY, input.proxyPassword);
    ciphertext = encrypted.ciphertext; iv = encrypted.iv;
  }

  if (mode === 'socks5') {
    return { mode, host: input.proxyHost!.trim(), port: input.proxyPort!, username: input.proxyUsername?.trim() || null, method: null, ciphertext, iv };
  }
  return { mode, host: input.proxyHost!.trim(), port: input.proxyPort!, username: null, method: input.proxyMethod!, ciphertext, iv };
}

async function markAccount(env: Env, id: string, ok: boolean, message: string | null = null) {
  if (ok) await env.DB.prepare("UPDATE mail_accounts SET last_ok_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  else await env.DB.prepare("UPDATE mail_accounts SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(message, id).run();
}
function sameOrigin(request: Request): boolean { const origin = request.headers.get('Origin'); return !origin || origin === new URL(request.url).origin; }
function oauthRedirect(origin: string, status: 'success' | 'error', message?: string): Response {
  const out = new URL('/', origin); out.searchParams.set('oauth', 'microsoft'); out.searchParams.set('status', status);
  if (message) out.searchParams.set('message', message.slice(0, 250)); return Response.redirect(out.toString(), 302);
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname;

  if (path === '/api/login' && request.method === 'POST') {
    const body = await request.json().catch(() => ({})) as { password?: string };
    if (!(await verifyAdminPassword(env, body.password || ''))) return json({ error: 'Invalid password' }, 401);
    const token = await createSession(env);
    return json({ ok: true }, 200, { 'Set-Cookie': `cloudmail_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` });
  }
  if (path === '/api/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': 'cloudmail_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });

  if (path === '/api/oauth/microsoft/callback' && request.method === 'GET') {
    const state = url.searchParams.get('state') || ''; const code = url.searchParams.get('code') || '';
    const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (!state) return oauthRedirect(url.origin, 'error', oauthError || 'Missing OAuth state');
    const pending = await env.DB.prepare("SELECT * FROM oauth_states WHERE state = ? AND provider = 'microsoft' AND created_at > datetime('now','-15 minutes')").bind(state).first<OAuthStateRow>();
    await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
    if (!pending) return oauthRedirect(url.origin, 'error', 'OAuth request expired or is invalid');
    if (oauthError || !code) return oauthRedirect(url.origin, 'error', oauthError || 'Microsoft did not return an authorization code');
    try {
      const token = await exchangeMicrosoftCode(env, code, pending.redirect_uri);
      const email = token.email && validEmail(token.email) ? token.email : pending.email;
      const encrypted = await encryptCredential(env.CREDENTIAL_KEY, token.refreshToken); const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO mail_accounts (id,label,email,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,credential_ciphertext,credential_iv) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, pending.label, email, 'outlook', 'oauth_microsoft', 'outlook.office365.com', 993, 'tls', 'smtp.office365.com', 587, 'starttls', email, encrypted.ciphertext, encrypted.iv).run();
      return oauthRedirect(url.origin, 'success');
    } catch (err) { return oauthRedirect(url.origin, 'error', errorMessage(err)); }
  }

  const authenticated = await verifySession(env, getCookie(request, 'cloudmail_session'));
  if (path === '/api/session' && request.method === 'GET') return json({ authenticated });
  if (!authenticated) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);

  if (path === '/api/oauth/microsoft/start' && request.method === 'POST') {
    const body = await request.json().catch(() => ({})) as { label?: string; email?: string };
    const label = body.label?.trim() || 'Microsoft'; const email = body.email?.trim() || '';
    if (!validEmail(email)) return json({ error: 'A valid Microsoft email address is required' }, 400);
    try {
      const state = crypto.randomUUID(); const redirectUri = `${url.origin}/api/oauth/microsoft/callback`;
      await env.DB.prepare("DELETE FROM oauth_states WHERE created_at <= datetime('now','-30 minutes')").run();
      await env.DB.prepare('INSERT INTO oauth_states (state, provider, label, email, redirect_uri) VALUES (?, ?, ?, ?, ?)').bind(state, 'microsoft', label, email, redirectUri).run();
      return json({ url: microsoftAuthorizeUrl(env, redirectUri, state) });
    } catch (err) { return json({ error: errorMessage(err) }, 500); }
  }

  if (path === '/api/accounts' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM mail_accounts ORDER BY created_at ASC').all<StoredAccount>();
    return json({ accounts: rows.results.map(publicAccount) });
  }

  if (path === '/api/accounts' && request.method === 'POST') {
    const input = await request.json() as MailAccountInput;
    if (input.provider === 'outlook') return json({ error: 'Outlook/Microsoft accounts must be added with Microsoft OAuth' }, 400);
    const invalid = validateAccount(input); if (invalid) return json({ error: invalid }, 400);
    const id = crypto.randomUUID(); const encrypted = await encryptCredential(env.CREDENTIAL_KEY, input.password); const px = await proxyValues(env, input);
    await env.DB.prepare(`INSERT INTO mail_accounts
      (id,label,email,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,credential_ciphertext,credential_iv,proxy_mode,proxy_host,proxy_port,proxy_username,proxy_password_ciphertext,proxy_password_iv,proxy_method)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, input.label.trim(), input.email.trim(), input.provider || 'custom', 'password', input.imapHost.trim(), input.imapPort,
        input.imapSecurity, input.smtpHost.trim(), input.smtpPort, input.smtpSecurity, input.username.trim(), encrypted.ciphertext, encrypted.iv,
        px.mode, px.host, px.port, px.username, px.ciphertext, px.iv, px.method).run();
    return json({ account: publicAccount((await getAccount(env, id))!) }, 201);
  }

  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && request.method === 'PUT') {
    const account = await getAccount(env, accountMatch[1]); if (!account) return json({ error: 'Account not found' }, 404);
    const input = await request.json() as MailAccountInput;
    const proxyError = validateProxy(input, account); if (proxyError) return json({ error: proxyError }, 400);
    const px = await proxyValues(env, input, account);

    if (account.auth_type === 'oauth_microsoft') {
      if (!input.label?.trim()) return json({ error: 'Label is required' }, 400);
      await env.DB.prepare(`UPDATE mail_accounts SET label=?,proxy_mode=?,proxy_host=?,proxy_port=?,proxy_username=?,proxy_password_ciphertext=?,proxy_password_iv=?,proxy_method=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(input.label.trim(), px.mode, px.host, px.port, px.username, px.ciphertext, px.iv, px.method, account.id).run();
    } else {
      const invalid = validateAccount(input, false, account); if (invalid) return json({ error: invalid }, 400);
      if (input.password?.trim()) {
        const encrypted = await encryptCredential(env.CREDENTIAL_KEY, input.password);
        await env.DB.prepare(`UPDATE mail_accounts SET label=?,email=?,imap_host=?,imap_port=?,imap_security=?,smtp_host=?,smtp_port=?,smtp_security=?,username=?,credential_ciphertext=?,credential_iv=?,proxy_mode=?,proxy_host=?,proxy_port=?,proxy_username=?,proxy_password_ciphertext=?,proxy_password_iv=?,proxy_method=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(input.label.trim(), input.email.trim(), input.imapHost.trim(), input.imapPort, input.imapSecurity, input.smtpHost.trim(), input.smtpPort, input.smtpSecurity, input.username.trim(), encrypted.ciphertext, encrypted.iv, px.mode, px.host, px.port, px.username, px.ciphertext, px.iv, px.method, account.id).run();
      } else {
        await env.DB.prepare(`UPDATE mail_accounts SET label=?,email=?,imap_host=?,imap_port=?,imap_security=?,smtp_host=?,smtp_port=?,smtp_security=?,username=?,proxy_mode=?,proxy_host=?,proxy_port=?,proxy_username=?,proxy_password_ciphertext=?,proxy_password_iv=?,proxy_method=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(input.label.trim(), input.email.trim(), input.imapHost.trim(), input.imapPort, input.imapSecurity, input.smtpHost.trim(), input.smtpPort, input.smtpSecurity, input.username.trim(), px.mode, px.host, px.port, px.username, px.ciphertext, px.iv, px.method, account.id).run();
      }
    }
    return json({ account: publicAccount((await getAccount(env, account.id))!) });
  }

  if (accountMatch && request.method === 'DELETE') { await env.DB.prepare('DELETE FROM mail_accounts WHERE id = ?').bind(accountMatch[1]).run(); return json({ ok: true }); }

  const testMatch = path.match(/^\/api\/accounts\/([^/]+)\/test$/);
  if (testMatch && request.method === 'POST') {
    const account = await getAccount(env, testMatch[1]); if (!account) return json({ error: 'Account not found' }, 404);
    try { await withImap(await imapCfg(env, account), client => client.recent(1)); await markAccount(env, account.id, true); return json({ ok: true }); }
    catch (err) { const msg = errorMessage(err); await markAccount(env, account.id, false, msg); return json({ error: msg }, 502); }
  }

  if (path === '/api/inbox' && request.method === 'GET') {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 40), 100));
    const accountId = url.searchParams.get('accountId')?.trim() || '';
    let accounts: StoredAccount[];
    if (accountId) {
      const account = await getAccount(env, accountId);
      if (!account) return json({ error: 'Account not found' }, 404);
      accounts = [account];
    } else {
      const rows = await env.DB.prepare('SELECT * FROM mail_accounts ORDER BY created_at ASC').all<StoredAccount>();
      accounts = rows.results;
    }
    const each = accountId ? limit : Math.max(5, Math.ceil(limit / Math.max(accounts.length, 1)) + 5);
    const messages: Array<Record<string, unknown>> = []; const failures: Array<{ accountId: string; error: string }> = [];
    for (const account of accounts) {
      try {
        const rows = await withImap(await imapCfg(env, account), client => client.recent(each));
        for (const m of rows) messages.push({ ...m, accountId: account.id, accountLabel: account.label, accountEmail: account.email });
        await markAccount(env, account.id, true);
      } catch (err) { const msg = errorMessage(err); failures.push({ accountId: account.id, error: msg }); await markAccount(env, account.id, false, msg); }
    }
    messages.sort((a, b) => (Date.parse(String(b.date || '')) || 0) - (Date.parse(String(a.date || '')) || 0));
    return json({ messages: messages.slice(0, limit), failures, accountCount: accounts.length, accountId: accountId || null });
  }

  const msgMatch = path.match(/^\/api\/accounts\/([^/]+)\/messages\/(\d+)$/);
  if (msgMatch && request.method === 'GET') {
    const account = await getAccount(env, msgMatch[1]); if (!account) return json({ error: 'Account not found' }, 404);
    try { const raw = await withImap(await imapCfg(env, account), client => client.fetchRaw(Number(msgMatch[2]))); return json({ message: parseMessage(raw), account: publicAccount(account) }); }
    catch (err) { return json({ error: errorMessage(err) }, 502); }
  }

  if (path === '/api/send' && request.method === 'POST') {
    const body = await request.json() as { accountId?: string; to?: string; subject?: string; text?: string };
    if (!body.accountId || !body.to?.trim()) return json({ error: 'accountId and to are required' }, 400);
    const account = await getAccount(env, body.accountId); if (!account) return json({ error: 'Account not found' }, 404);
    try { await sendMail(await smtpCfg(env, account), body.to, body.subject || '', body.text || ''); await markAccount(env, account.id, true); return json({ ok: true }); }
    catch (err) { const msg = errorMessage(err); await markAccount(env, account.id, false, msg); return json({ error: msg }, 502); }
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env); }
      catch (err) { return json({ error: errorMessage(err) }, 500); }
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
