import type { Env, MailAccountInput, StoredAccount } from './types';
import { createSession, decryptCredential, encryptCredential, getCookie, verifyAdminPassword, verifySession } from './lib/crypto';
import { withImap } from './lib/imap';
import { parseMessage } from './lib/mime';
import { sendMail } from './lib/smtp';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

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

function validateAccount(input: MailAccountInput): string | null {
  if (!input.label?.trim()) return 'Label is required';
  if (!/^\S+@\S+\.\S+$/.test(input.email || '')) return 'A valid email address is required';
  if (!validHost(input.imapHost || '') || !validHost(input.smtpHost || '')) return 'Invalid mail server hostname';
  for (const p of [input.imapPort, input.smtpPort]) if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Invalid port';
  if (input.smtpPort === 25) return 'SMTP port 25 is blocked by Cloudflare Workers; use 465 or 587';
  if (!['tls', 'starttls'].includes(input.imapSecurity)) return 'IMAP must use TLS or STARTTLS';
  if (!['tls', 'starttls'].includes(input.smtpSecurity)) return 'SMTP must use TLS or STARTTLS';
  if (!input.username || !input.password) return 'Username and password/app password are required';
  return null;
}

function publicAccount(a: StoredAccount) {
  return {
    id: a.id, label: a.label, email: a.email, provider: a.provider,
    imapHost: a.imap_host, imapPort: a.imap_port, imapSecurity: a.imap_security,
    smtpHost: a.smtp_host, smtpPort: a.smtp_port, smtpSecurity: a.smtp_security,
    username: a.username, createdAt: a.created_at, updatedAt: a.updated_at,
    lastOkAt: a.last_ok_at, lastError: a.last_error
  };
}

async function getAccount(env: Env, id: string): Promise<StoredAccount | null> {
  return await env.DB.prepare('SELECT * FROM mail_accounts WHERE id = ?').bind(id).first<StoredAccount>();
}

async function accountSecret(env: Env, account: StoredAccount): Promise<string> {
  return decryptCredential(env.CREDENTIAL_KEY, account.credential_ciphertext, account.credential_iv);
}

function imapCfg(account: StoredAccount, password: string) {
  return { host: account.imap_host, port: account.imap_port, security: account.imap_security, username: account.username, password };
}

async function markAccount(env: Env, id: string, ok: boolean, message: string | null = null) {
  if (ok) await env.DB.prepare("UPDATE mail_accounts SET last_ok_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  else await env.DB.prepare("UPDATE mail_accounts SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(message, id).run();
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/login' && request.method === 'POST') {
    const body = await request.json().catch(() => ({})) as { password?: string };
    if (!(await verifyAdminPassword(env, body.password || ''))) return json({ error: 'Invalid password' }, 401);
    const token = await createSession(env);
    return json({ ok: true }, 200, {
      'Set-Cookie': `cloudmail_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`
    });
  }

  if (path === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': 'cloudmail_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }

  const authenticated = await verifySession(env, getCookie(request, 'cloudmail_session'));
  if (path === '/api/session' && request.method === 'GET') return json({ authenticated });
  if (!authenticated) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);

  if (path === '/api/accounts' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM mail_accounts ORDER BY created_at ASC').all<StoredAccount>();
    return json({ accounts: rows.results.map(publicAccount) });
  }

  if (path === '/api/accounts' && request.method === 'POST') {
    const input = await request.json() as MailAccountInput;
    const invalid = validateAccount(input);
    if (invalid) return json({ error: invalid }, 400);
    const id = crypto.randomUUID();
    const encrypted = await encryptCredential(env.CREDENTIAL_KEY, input.password);
    await env.DB.prepare(`INSERT INTO mail_accounts
      (id,label,email,provider,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,credential_ciphertext,credential_iv)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, input.label.trim(), input.email.trim(), input.provider || 'custom', input.imapHost.trim(), input.imapPort,
        input.imapSecurity, input.smtpHost.trim(), input.smtpPort, input.smtpSecurity, input.username.trim(), encrypted.ciphertext, encrypted.iv).run();
    const account = await getAccount(env, id);
    return json({ account: publicAccount(account!) }, 201);
  }

  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM mail_accounts WHERE id = ?').bind(accountMatch[1]).run();
    return json({ ok: true });
  }

  const testMatch = path.match(/^\/api\/accounts\/([^/]+)\/test$/);
  if (testMatch && request.method === 'POST') {
    const account = await getAccount(env, testMatch[1]);
    if (!account) return json({ error: 'Account not found' }, 404);
    try {
      const password = await accountSecret(env, account);
      await withImap(imapCfg(account, password), client => client.recent(1));
      await markAccount(env, account.id, true);
      return json({ ok: true });
    } catch (err) {
      const msg = errorMessage(err); await markAccount(env, account.id, false, msg);
      return json({ error: msg }, 502);
    }
  }

  if (path === '/api/inbox' && request.method === 'GET') {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 40), 100));
    const rows = await env.DB.prepare('SELECT * FROM mail_accounts ORDER BY created_at ASC').all<StoredAccount>();
    const accounts = rows.results;
    const each = Math.max(5, Math.ceil(limit / Math.max(accounts.length, 1)) + 5);
    const messages: Array<Record<string, unknown>> = [];
    const failures: Array<{ accountId: string; error: string }> = [];

    // Sequential on purpose: Workers have a finite simultaneous outbound-connection budget.
    for (const account of accounts) {
      try {
        const password = await accountSecret(env, account);
        const rows = await withImap(imapCfg(account, password), client => client.recent(each));
        for (const m of rows) messages.push({ ...m, accountId: account.id, accountLabel: account.label, accountEmail: account.email });
        await markAccount(env, account.id, true);
      } catch (err) {
        const msg = errorMessage(err); failures.push({ accountId: account.id, error: msg });
        await markAccount(env, account.id, false, msg);
      }
    }

    messages.sort((a, b) => {
      const at = Date.parse(String(a.date || '')) || 0;
      const bt = Date.parse(String(b.date || '')) || 0;
      return bt - at;
    });
    return json({ messages: messages.slice(0, limit), failures });
  }

  const msgMatch = path.match(/^\/api\/accounts\/([^/]+)\/messages\/(\d+)$/);
  if (msgMatch && request.method === 'GET') {
    const account = await getAccount(env, msgMatch[1]);
    if (!account) return json({ error: 'Account not found' }, 404);
    try {
      const password = await accountSecret(env, account);
      const raw = await withImap(imapCfg(account, password), client => client.fetchRaw(Number(msgMatch[2])));
      return json({ message: parseMessage(raw), account: publicAccount(account) });
    } catch (err) {
      return json({ error: errorMessage(err) }, 502);
    }
  }

  if (path === '/api/send' && request.method === 'POST') {
    const body = await request.json() as { accountId?: string; to?: string; subject?: string; text?: string };
    if (!body.accountId || !body.to?.trim()) return json({ error: 'accountId and to are required' }, 400);
    const account = await getAccount(env, body.accountId);
    if (!account) return json({ error: 'Account not found' }, 404);
    try {
      const password = await accountSecret(env, account);
      await sendMail({
        host: account.smtp_host, port: account.smtp_port, security: account.smtp_security,
        username: account.username, password, from: account.email
      }, body.to, body.subject || '', body.text || '');
      await markAccount(env, account.id, true);
      return json({ ok: true });
    } catch (err) {
      const msg = errorMessage(err); await markAccount(env, account.id, false, msg);
      return json({ error: msg }, 502);
    }
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
