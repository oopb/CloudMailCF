import { connect as cfConnect, type Socket as CfSocket } from 'cloudflare:sockets';
import net from 'node:net';
import tls from 'node:tls';
import type { Socket as NodeSocket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import type { ProxyConfig, SecurityMode } from '../types';
import { openShadowsocksTunnel } from './shadowsocks';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type NodeAnySocket = NodeSocket | TLSSocket | Duplex;

function waitEvent(socket: NodeSocket | TLSSocket, event: 'connect' | 'secureConnect'): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { cleanup(); reject(err); };
    const onReady = () => { cleanup(); resolve(); };
    const cleanup = () => {
      socket.off('error', onError);
      socket.off(event, onReady);
    };
    socket.once('error', onError);
    socket.once(event, onReady);
  });
}

interface ChannelImpl {
  write(data: string | Uint8Array): Promise<void>;
  writeLine(line: string): Promise<void>;
  readExact(n: number): Promise<Uint8Array>;
  readLine(): Promise<string>;
  upgradeTls(): Promise<void>;
  close(): Promise<void>;
}

class CfChannel implements ChannelImpl {
  private socket: CfSocket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);

  constructor(socket: CfSocket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async upgradeTls(): Promise<void> {
    this.reader.releaseLock();
    this.writer.releaseLock();
    const secure = this.socket.startTls();
    await secure.opened;
    this.socket = secure;
    this.reader = secure.readable.getReader();
    this.writer = secure.writable.getWriter();
    this.buffer = new Uint8Array(0);
  }

  async write(data: string | Uint8Array): Promise<void> {
    await this.writer.write(typeof data === 'string' ? encoder.encode(data) : data);
  }

  async writeLine(line: string): Promise<void> { await this.write(`${line}\r\n`); }

  private append(chunk: Uint8Array) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  private async ensure(n: number): Promise<void> {
    while (this.buffer.length < n) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('Remote socket closed unexpectedly');
      if (value) this.append(value);
    }
  }

  async readExact(n: number): Promise<Uint8Array> {
    await this.ensure(n);
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }

  async readLine(): Promise<string> {
    while (true) {
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = decoder.decode(this.buffer.slice(0, i));
          this.buffer = this.buffer.slice(i + 2);
          return line;
        }
      }
      const { value, done } = await this.reader.read();
      if (done) {
        if (this.buffer.length) {
          const line = decoder.decode(this.buffer);
          this.buffer = new Uint8Array(0);
          return line;
        }
        throw new Error('Remote socket closed unexpectedly');
      }
      if (value) this.append(value);
    }
  }

  async close(): Promise<void> {
    try { this.reader.releaseLock(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    try { await this.socket.close(); } catch {}
  }
}

class NodeChannel implements ChannelImpl {
  private socket: NodeAnySocket;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private waiters: Array<() => void> = [];
  private ended = false;
  private failure: Error | null = null;
  private secure = false;

  constructor(socket: NodeAnySocket, private targetHost: string, secure = false) {
    this.socket = socket;
    this.secure = secure;
    this.bindSocket(socket);
  }

  private bindSocket(socket: NodeAnySocket) {
    socket.on('data', (chunk: Uint8Array) => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
      this.chunks.push(bytes);
      this.buffered += bytes.length;
      this.flushWaiters();
    });
    socket.once('end', () => { this.ended = true; this.flushWaiters(); });
    socket.once('close', () => { this.ended = true; this.flushWaiters(); });
    socket.once('error', (err: Error) => { this.failure = err instanceof Error ? err : new Error(String(err)); this.flushWaiters(); });
  }

  private flushWaiters() { for (const r of this.waiters.splice(0)) r(); }
  private async waitForData() {
    if (this.buffered || this.ended || this.failure) return;
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  private async ensure(n: number) {
    while (this.buffered < n) {
      if (this.failure) throw this.failure;
      if (this.ended) throw new Error('Remote socket closed unexpectedly');
      await this.waitForData();
    }
  }
  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const need = n - offset;
      if (head.length <= need) {
        out.set(head, offset); offset += head.length; this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), offset); this.chunks[0] = head.slice(need); offset += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  async upgradeTls(): Promise<void> {
    if (this.secure) return;
    if (this.buffered) throw new Error('Cannot start TLS while unread socket data is buffered');
    const old = this.socket;
    old.removeAllListeners('data'); old.removeAllListeners('end'); old.removeAllListeners('close'); old.removeAllListeners('error');
    const secure = tls.connect({ socket: old as NodeSocket, servername: this.targetHost });
    await waitEvent(secure, 'secureConnect');
    this.socket = secure;
    this.secure = true;
    this.ended = false;
    this.failure = null;
    this.bindSocket(secure);
  }

  async write(data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    await new Promise<void>((resolve, reject) => this.socket.write(bytes, err => err ? reject(err) : resolve()));
  }
  async writeLine(line: string): Promise<void> { await this.write(`${line}\r\n`); }
  async readExact(n: number): Promise<Uint8Array> { await this.ensure(n); return this.take(n); }

  async readLine(): Promise<string> {
    while (true) {
      const all = new Uint8Array(this.buffered);
      let p = 0;
      for (const chunk of this.chunks) { all.set(chunk, p); p += chunk.length; }
      for (let i = 0; i + 1 < all.length; i++) {
        if (all[i] === 13 && all[i + 1] === 10) {
          const line = decoder.decode(this.take(i));
          this.take(2);
          return line;
        }
      }
      if (this.failure) throw this.failure;
      if (this.ended) {
        if (this.buffered) return decoder.decode(this.take(this.buffered));
        throw new Error('Remote socket closed unexpectedly');
      }
      await this.waitForData();
    }
  }

  async close(): Promise<void> {
    try { this.socket.end(); } catch {}
    try { this.socket.destroy(); } catch {}
  }
}

export class ByteChannel {
  private constructor(private impl: ChannelImpl) {}

  static async open(hostname: string, port: number, security: SecurityMode, proxy?: ProxyConfig): Promise<ByteChannel> {
    if (!proxy || proxy.mode === 'direct') {
      const secureTransport = security === 'tls' ? 'on' : security === 'starttls' ? 'starttls' : 'off';
      const socket = cfConnect({ hostname, port }, { secureTransport });
      await socket.opened;
      return new ByteChannel(new CfChannel(socket));
    }

    let socket: NodeAnySocket;
    if (proxy.mode === 'socks5') socket = await this.openSocks5(hostname, port, proxy);
    else if (proxy.mode === 'shadowsocks') socket = await openShadowsocksTunnel(hostname, port, proxy);
    else throw new Error(`Unsupported proxy mode: ${String(proxy.mode)}`);

    const impl = new NodeChannel(socket, hostname, false);
    if (security === 'tls') await impl.upgradeTls();
    return new ByteChannel(impl);
  }

  private static async openSocks5(hostname: string, port: number, proxy: ProxyConfig): Promise<NodeSocket> {
    if (!proxy.host || !proxy.port) throw new Error('SOCKS5 proxy host/port is missing');
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    await waitEvent(socket, 'connect');
    const ch = new NodeChannel(socket, hostname);

    const hasAuth = !!proxy.username;
    await ch.write(new Uint8Array([0x05, hasAuth ? 0x02 : 0x01, 0x00, ...(hasAuth ? [0x02] : [])]));
    const hello = await ch.readExact(2);
    if (hello[0] !== 0x05 || hello[1] === 0xff) throw new Error('SOCKS5 proxy rejected authentication methods');

    if (hello[1] === 0x02) {
      const u = encoder.encode(proxy.username || '');
      const p = encoder.encode(proxy.password || '');
      if (u.length > 255 || p.length > 255) throw new Error('SOCKS5 username/password is too long');
      await ch.write(new Uint8Array([0x01, u.length, ...u, p.length, ...p]));
      const auth = await ch.readExact(2);
      if (auth[1] !== 0x00) throw new Error('SOCKS5 username/password authentication failed');
    } else if (hello[1] !== 0x00) {
      throw new Error(`SOCKS5 proxy selected unsupported auth method 0x${hello[1].toString(16)}`);
    }

    const host = encoder.encode(hostname);
    if (host.length > 255) throw new Error('Target hostname is too long for SOCKS5');
    await ch.write(new Uint8Array([0x05, 0x01, 0x00, 0x03, host.length, ...host, (port >> 8) & 0xff, port & 0xff]));
    const head = await ch.readExact(4);
    if (head[0] !== 0x05 || head[1] !== 0x00) throw new Error(`SOCKS5 CONNECT failed with code 0x${head[1].toString(16)}`);
    if (head[3] === 0x01) await ch.readExact(6);
    else if (head[3] === 0x04) await ch.readExact(18);
    else if (head[3] === 0x03) { const len = (await ch.readExact(1))[0]; await ch.readExact(len + 2); }
    else throw new Error('SOCKS5 proxy returned an invalid address type');

    socket.removeAllListeners('data'); socket.removeAllListeners('end'); socket.removeAllListeners('close'); socket.removeAllListeners('error');
    return socket;
  }

  write(data: string | Uint8Array) { return this.impl.write(data); }
  writeLine(line: string) { return this.impl.writeLine(line); }
  readExact(n: number) { return this.impl.readExact(n); }
  readLine() { return this.impl.readLine(); }
  upgradeTls() { return this.impl.upgradeTls(); }
  close() { return this.impl.close(); }
}
