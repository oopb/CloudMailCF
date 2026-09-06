import type { Env } from '../types';

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function b64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptCredential(secret: string, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    enc.encode(plaintext)
  );
  return { ciphertext: bytesToB64(new Uint8Array(cipher)), iv: bytesToB64(iv) };
}

export async function decryptCredential(secret: string, ciphertext: string, iv: string): Promise<string> {
  const key = await aesKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(b64ToBytes(iv)) },
    key,
    toArrayBuffer(b64ToBytes(ciphertext))
  );
  return dec.decode(plain);
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyAdminPassword(env: Env, password: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(password)),
    crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_PASSWORD))
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

export async function createSession(env: Env, ttlSeconds = 60 * 60 * 24 * 30): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = crypto.randomUUID();
  const payload = `v1.${exp}.${nonce}`;
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(env: Env, token: string | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const payload = parts.slice(0, 3).join('.');
  const expected = await hmac(env.SESSION_SECRET, payload);
  const given = parts[3].replace(/-/g, '+').replace(/_/g, '/');
  const padded = given + '='.repeat((4 - (given.length % 4)) % 4);
  try {
    return timingSafeEqual(expected, b64ToBytes(padded));
  } catch {
    return false;
  }
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
