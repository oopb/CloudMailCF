import type { Env, StoredAccount } from '../types';
import { decryptCredential, encryptCredential } from './crypto';

const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send'
].join(' ');

interface MicrosoftTokenResponse {
  token_type: string;
  scope?: string;
  expires_in?: number;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

function tenant(env: Env): string {
  return (env.MICROSOFT_TENANT || 'common').trim() || 'common';
}

function ensureConfigured(env: Env): void {
  if (!env.MICROSOFT_CLIENT_ID?.trim()) throw new Error('Microsoft OAuth is not configured: MICROSOFT_CLIENT_ID is missing');
  if (!env.MICROSOFT_CLIENT_SECRET?.trim()) throw new Error('Microsoft OAuth is not configured: MICROSOFT_CLIENT_SECRET is missing');
}

function parseJwtPayload(token?: string): Record<string, unknown> {
  if (!token) return {};
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

async function tokenRequest(env: Env, params: URLSearchParams): Promise<MicrosoftTokenResponse> {
  ensureConfigured(env);
  params.set('client_id', env.MICROSOFT_CLIENT_ID!.trim());
  params.set('client_secret', env.MICROSOFT_CLIENT_SECRET!.trim());
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant(env))}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await response.json() as MicrosoftTokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(`Microsoft OAuth token request failed: ${data.error_description || data.error || response.status}`);
  }
  return data;
}

export function microsoftAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  ensureConfigured(env);
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenant(env))}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', env.MICROSOFT_CLIENT_ID!.trim());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', MICROSOFT_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeMicrosoftCode(env: Env, code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; email?: string }> {
  const data = await tokenRequest(env, new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: MICROSOFT_SCOPES
  }));
  if (!data.refresh_token) throw new Error('Microsoft did not return a refresh token. Ensure offline_access is granted.');
  const claims = parseJwtPayload(data.id_token);
  const email = String(claims.preferred_username || claims.email || '').trim() || undefined;
  return { accessToken: data.access_token, refreshToken: data.refresh_token, email };
}

export async function microsoftAccessToken(env: Env, account: StoredAccount): Promise<string> {
  const refreshToken = await decryptCredential(env.CREDENTIAL_KEY, account.credential_ciphertext, account.credential_iv);
  const data = await tokenRequest(env, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES
  }));

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    const encrypted = await encryptCredential(env.CREDENTIAL_KEY, data.refresh_token);
    await env.DB.prepare('UPDATE mail_accounts SET credential_ciphertext = ?, credential_iv = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(encrypted.ciphertext, encrypted.iv, account.id).run();
  }
  return data.access_token;
}
