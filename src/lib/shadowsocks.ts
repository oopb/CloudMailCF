import net from 'node:net';
import { Duplex } from 'node:stream';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import type { ProxyConfig, ShadowsocksMethod } from '../types';

type Bytes = Uint8Array<ArrayBufferLike>;
const enc = new TextEncoder();
const TAG_LEN = 16;
const MAX_CHUNK = 0x3fff;
const SS2022_CONTEXT: Bytes = enc.encode('shadowsocks 2022 session subkey');

interface MethodInfo {
  keyLen: number;
  saltLen: number;
  is2022: boolean;
  cipher: 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-poly1305' | 'chacha8-poly1305';
}

const METHODS: Record<ShadowsocksMethod, MethodInfo> = {
  'aes-128-gcm': { keyLen: 16, saltLen: 16, is2022: false, cipher: 'aes-128-gcm' },
  'aes-256-gcm': { keyLen: 32, saltLen: 32, is2022: false, cipher: 'aes-256-gcm' },
  'chacha20-ietf-poly1305': { keyLen: 32, saltLen: 32, is2022: false, cipher: 'chacha20-poly1305' },
  '2022-blake3-aes-128-gcm': { keyLen: 16, saltLen: 16, is2022: true, cipher: 'aes-128-gcm' },
  '2022-blake3-aes-256-gcm': { keyLen: 32, saltLen: 32, is2022: true, cipher: 'aes-256-gcm' },
  '2022-blake3-chacha20-poly1305': { keyLen: 32, saltLen: 32, is2022: true, cipher: 'chacha20-poly1305' },
  '2022-blake3-chacha8-poly1305': { keyLen: 32, saltLen: 32, is2022: true, cipher: 'chacha8-poly1305' }
};

function concat(...parts: Bytes[]): Bytes {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function u16be(n: number): Bytes { return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]); }
function readU16be(b: Bytes, off = 0): number { return (b[off] << 8) | b[off + 1]; }
function u64be(n: number): Bytes { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(Math.floor(n)), false); return out; }
function readU64be(b: Bytes, off = 0): number { return Number(new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, false)); }
function u64le(n: number): Bytes { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(n), true); return out; }
function nextNonce(nonce: Bytes): Bytes {
  const out = nonce.slice();
  for (let i = 0; i < out.length; i++) { out[i] = (out[i] + 1) & 0xff; if (out[i] !== 0) break; }
  return out;
}
function addressHeader(host: string, port: number): Bytes {
  const h: Bytes = enc.encode(host); if (h.length > 255) throw new Error('Shadowsocks target hostname is too long');
  return concat(new Uint8Array([0x03, h.length]), h, u16be(port));
}
function evpBytesToKey(password: string, keyLen: number): Bytes {
  const p: Bytes = enc.encode(password); let out: Bytes = new Uint8Array(0); let prev: Bytes = new Uint8Array(0);
  while (out.length < keyLen) {
    const h = createHash('md5'); if (prev.length) h.update(prev); h.update(p);
    prev = Uint8Array.from(h.digest()); out = concat(out, prev);
  }
  return out.slice(0, keyLen);
}
function decode2022Psk(value: string, keyLen: number): Bytes {
  let bin: string; try { bin = atob(value.trim()); } catch { throw new Error('Shadowsocks 2022 password must be a Base64 PSK'); }
  const out: Bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  if (out.length !== keyLen) throw new Error(`Shadowsocks 2022 PSK must decode to exactly ${keyLen} bytes`);
  return out;
}
function deriveSubkey(master: Bytes, salt: Bytes, info: MethodInfo): Bytes {
  if (info.is2022) return new Uint8Array(blake3(concat(master, salt), { context: SS2022_CONTEXT, dkLen: info.keyLen }));
  return Uint8Array.from(hkdfSync('sha1', master, salt, enc.encode('ss-subkey'), info.keyLen) as unknown as ArrayLike<number>);
}
function equalTag(a: Bytes, b: Bytes): boolean { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

function rotl(v: number, n: number): number { return ((v << n) | (v >>> (32 - n))) >>> 0; }
function qr(s: Uint32Array, a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}
function chachaBlock(key: Bytes, nonce: Bytes, counter: number, rounds: number): Bytes {
  const constants = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  const kd = new DataView(key.buffer, key.byteOffset, key.byteLength); const nd = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  const initial = new Uint32Array(16); initial.set(constants, 0);
  for (let i = 0; i < 8; i++) initial[4 + i] = kd.getUint32(i * 4, true);
  initial[12] = counter >>> 0; initial[13] = nd.getUint32(0, true); initial[14] = nd.getUint32(4, true); initial[15] = nd.getUint32(8, true);
  const s = initial.slice();
  for (let i = 0; i < rounds; i += 2) {
    qr(s, 0, 4, 8, 12); qr(s, 1, 5, 9, 13); qr(s, 2, 6, 10, 14); qr(s, 3, 7, 11, 15);
    qr(s, 0, 5, 10, 15); qr(s, 1, 6, 11, 12); qr(s, 2, 7, 8, 13); qr(s, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64); const od = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) od.setUint32(i * 4, (s[i] + initial[i]) >>> 0, true);
  return out;
}
function chachaXor(key: Bytes, nonce: Bytes, input: Bytes, rounds: number, counter = 1): Bytes {
  const out = new Uint8Array(input.length);
  for (let off = 0; off < input.length; off += 64, counter++) {
    const block = chachaBlock(key, nonce, counter, rounds); const n = Math.min(64, input.length - off);
    for (let i = 0; i < n; i++) out[off + i] = input[off + i] ^ block[i];
  }
  return out;
}
function leBigInt(bytes: Bytes): bigint { let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n; }
function bigIntLe(n: bigint, len: number): Bytes { const out = new Uint8Array(len); for (let i = 0; i < len; i++) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; }
function poly1305(message: Bytes, key: Bytes): Bytes {
  const rBytes = key.slice(0, 16); rBytes[3] &= 15; rBytes[7] &= 15; rBytes[11] &= 15; rBytes[15] &= 15; rBytes[4] &= 252; rBytes[8] &= 252; rBytes[12] &= 252;
  const r = leBigInt(rBytes), s = leBigInt(key.slice(16, 32)), p = (1n << 130n) - 5n; let acc = 0n;
  for (let off = 0; off < message.length; off += 16) {
    const block = message.slice(off, Math.min(off + 16, message.length)); const n = leBigInt(block) + (1n << BigInt(block.length * 8)); acc = ((acc + n) * r) % p;
  }
  return bigIntLe((acc + s) & ((1n << 128n) - 1n), 16);
}
function pad16(x: Bytes): Bytes { const n = (16 - (x.length % 16)) % 16; return n ? concat(x, new Uint8Array(n)) : x; }
function chacha8Seal(key: Bytes, nonce: Bytes, plain: Bytes): Bytes {
  const polyKey = chachaBlock(key, nonce, 0, 8).slice(0, 32); const ct = chachaXor(key, nonce, plain, 8, 1);
  return concat(ct, poly1305(concat(pad16(ct), u64le(0), u64le(ct.length)), polyKey));
}
function chacha8Open(key: Bytes, nonce: Bytes, data: Bytes): Bytes {
  if (data.length < TAG_LEN) throw new Error('Shadowsocks chacha8 ciphertext is truncated');
  const ct = data.slice(0, -TAG_LEN), tag = data.slice(-TAG_LEN); const polyKey = chachaBlock(key, nonce, 0, 8).slice(0, 32);
  const expected = poly1305(concat(pad16(ct), u64le(0), u64le(ct.length)), polyKey);
  if (!equalTag(tag, expected)) throw new Error('Shadowsocks chacha8 authentication failed');
  return chachaXor(key, nonce, ct, 8, 1);
}
function seal(info: MethodInfo, key: Bytes, nonce: Bytes, plain: Bytes): Bytes {
  if (info.cipher === 'chacha8-poly1305') return chacha8Seal(key, nonce, plain);
  const cipher = createCipheriv(info.cipher as any, key, nonce, { authTagLength: TAG_LEN } as any);
  return concat(Uint8Array.from(cipher.update(plain)), Uint8Array.from(cipher.final()), Uint8Array.from(cipher.getAuthTag()));
}
function open(info: MethodInfo, key: Bytes, nonce: Bytes, data: Bytes): Bytes {
  if (info.cipher === 'chacha8-poly1305') return chacha8Open(key, nonce, data);
  if (data.length < TAG_LEN) throw new Error('Shadowsocks ciphertext is truncated');
  const body = data.slice(0, -TAG_LEN), tag = data.slice(-TAG_LEN);
  const decipher = createDecipheriv(info.cipher as any, key, nonce, { authTagLength: TAG_LEN } as any); decipher.setAuthTag(tag);
  return concat(Uint8Array.from(decipher.update(body)), Uint8Array.from(decipher.final()));
}

class ShadowsocksDuplex extends Duplex {
  private incoming: Bytes = new Uint8Array(0);
  private reqNonce: Bytes = new Uint8Array(12);
  private respNonce: Bytes = new Uint8Array(12);
  private reqSalt: Bytes;
  private reqKey: Bytes;
  private respKey: Bytes | null = null;
  private firstWrite = true;
  private responseHeaderDone = false;
  private responsePayloadLen: number | null = null;
  private responseInitialLen: number | null = null;

  constructor(private socket: net.Socket, private targetHost: string, private targetPort: number, private info: MethodInfo, private masterKey: Bytes) {
    super();
    this.reqSalt = Uint8Array.from(randomBytes(info.saltLen)); this.reqKey = deriveSubkey(masterKey, this.reqSalt, info);
    socket.on('data', chunk => { this.incoming = concat(this.incoming, Uint8Array.from(chunk)); this.processIncoming(); });
    socket.once('end', () => this.push(null)); socket.once('close', () => { if (!this.destroyed) this.push(null); }); socket.once('error', err => this.destroy(err));
  }
  _read(): void {}
  private writeRaw(data: Bytes, cb: (error?: Error | null) => void) { this.socket.write(data, err => cb(err || undefined)); }
  private framed(data: Bytes): Bytes {
    const parts: Bytes[] = [];
    for (let off = 0; off < data.length; off += MAX_CHUNK) {
      const chunk = data.slice(off, off + MAX_CHUNK);
      parts.push(seal(this.info, this.reqKey, this.reqNonce, u16be(chunk.length))); this.reqNonce = nextNonce(this.reqNonce);
      parts.push(seal(this.info, this.reqKey, this.reqNonce, chunk)); this.reqNonce = nextNonce(this.reqNonce);
    }
    return concat(...parts);
  }
  _write(chunk: Uint8Array, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    try {
      const data: Bytes = Uint8Array.from(chunk);
      if (!this.firstWrite) { this.writeRaw(this.framed(data), cb); return; }
      this.firstWrite = false; const addr = addressHeader(this.targetHost, this.targetPort);
      if (!this.info.is2022) {
        const firstRoom = Math.max(0, MAX_CHUNK - addr.length); const firstPayload = concat(addr, data.slice(0, firstRoom));
        this.writeRaw(concat(this.reqSalt, this.framed(firstPayload), this.framed(data.slice(firstRoom))), cb); return;
      }
      const firstPayload = data.slice(0, MAX_CHUNK); const variable = concat(addr, u16be(0), firstPayload);
      const fixed = concat(new Uint8Array([0]), u64be(Date.now() / 1000), u16be(variable.length));
      const c1 = seal(this.info, this.reqKey, this.reqNonce, fixed); this.reqNonce = nextNonce(this.reqNonce);
      const c2 = seal(this.info, this.reqKey, this.reqNonce, variable); this.reqNonce = nextNonce(this.reqNonce);
      const rest = data.slice(firstPayload.length); this.writeRaw(concat(this.reqSalt, c1, c2, rest.length ? this.framed(rest) : new Uint8Array(0)), cb);
    } catch (err) { cb(err instanceof Error ? err : new Error(String(err))); }
  }
  _final(cb: (error?: Error | null) => void): void { this.socket.end(() => cb()); }
  _destroy(error: Error | null, cb: (error?: Error | null) => void): void { this.socket.destroy(); cb(error); }
  private consume(n: number): Bytes { const out = this.incoming.slice(0, n); this.incoming = this.incoming.slice(n); return out; }
  private processIncoming() {
    try {
      while (true) {
        if (!this.respKey) {
          if (this.incoming.length < this.info.saltLen) return;
          this.respKey = deriveSubkey(this.masterKey, this.consume(this.info.saltLen), this.info);
        }
        if (this.info.is2022 && !this.responseHeaderDone) {
          const fixedLen = 1 + 8 + this.info.saltLen + 2;
          if (this.incoming.length < fixedLen + TAG_LEN) return;
          const fixed = open(this.info, this.respKey, this.respNonce, this.consume(fixedLen + TAG_LEN)); this.respNonce = nextNonce(this.respNonce);
          if (fixed[0] !== 1) throw new Error('Invalid Shadowsocks 2022 response header type');
          const ts = readU64be(fixed, 1); if (Math.abs(Date.now() / 1000 - ts) > 30) throw new Error('Shadowsocks 2022 response timestamp is outside the allowed window');
          if (!equalTag(fixed.slice(9, 9 + this.info.saltLen), this.reqSalt)) throw new Error('Shadowsocks 2022 response does not match request salt');
          this.responseInitialLen = readU16be(fixed, 9 + this.info.saltLen); this.responseHeaderDone = true;
          if (this.responseInitialLen === 0) { this.responseInitialLen = null; continue; }
        }
        if (this.info.is2022 && this.responseInitialLen !== null) {
          const n = this.responseInitialLen; if (this.incoming.length < n + TAG_LEN) return;
          const plain = open(this.info, this.respKey, this.respNonce, this.consume(n + TAG_LEN)); this.respNonce = nextNonce(this.respNonce); this.responseInitialLen = null;
          if (plain.length) this.push(plain); continue;
        }
        if (this.responsePayloadLen === null) {
          if (this.incoming.length < 2 + TAG_LEN) return;
          const lenPlain = open(this.info, this.respKey, this.respNonce, this.consume(2 + TAG_LEN)); this.respNonce = nextNonce(this.respNonce); this.responsePayloadLen = readU16be(lenPlain);
        }
        const n = this.responsePayloadLen; if (this.incoming.length < n + TAG_LEN) return;
        const plain = open(this.info, this.respKey, this.respNonce, this.consume(n + TAG_LEN)); this.respNonce = nextNonce(this.respNonce); this.responsePayloadLen = null;
        if (plain.length) this.push(plain);
      }
    } catch (err) { this.destroy(err instanceof Error ? err : new Error(String(err))); }
  }
}

export async function openShadowsocksTunnel(targetHost: string, targetPort: number, proxy: ProxyConfig): Promise<Duplex> {
  if (proxy.mode !== 'shadowsocks') throw new Error('Invalid Shadowsocks proxy mode');
  if (!proxy.host || !proxy.port || !proxy.password || !proxy.ssMethod) throw new Error('Shadowsocks server, port, method and password/PSK are required');
  const info = METHODS[proxy.ssMethod]; if (!info) throw new Error(`Unsupported Shadowsocks method: ${proxy.ssMethod}`);
  const master = info.is2022 ? decode2022Psk(proxy.password, info.keyLen) : evpBytesToKey(proxy.password, info.keyLen);
  const socket = net.connect({ host: proxy.host, port: proxy.port });
  await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); }; const fail = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => { socket.off('connect', done); socket.off('error', fail); }; socket.once('connect', done); socket.once('error', fail);
  });
  return new ShadowsocksDuplex(socket, targetHost, targetPort, info, master);
}
