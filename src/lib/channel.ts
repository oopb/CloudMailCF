import net from 'node:net';
import tls from 'node:tls';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { ProxyConfig, SecurityMode } from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type AnySocket = Socket | TLSSocket;

function waitEvent(socket: AnySocket, event: 'connect' | 'secureConnect'): Promise<void> {
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

export class ByteChannel {
  private socket: AnySocket;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private waiters: Array<() => void> = [];
  private ended = false;
  private failure: Error | null = null;
  private targetHost: string;

  private constructor(socket: AnySocket, targetHost: string) {
    this.socket = socket;
    this.targetHost = targetHost;
    this.bindSocket(socket);
  }

  private bindSocket(socket: AnySocket) {
    socket.on('data', chunk => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
      this.chunks.push(bytes);
      this.buffered += bytes.length;
      this.flushWaiters();
    });
    socket.once('end', () => { this.ended = true; this.flushWaiters(); });
    socket.once('close', () => { this.ended = true; this.flushWaiters(); });
    socket.once('error', err => { this.failure = err instanceof Error ? err : new Error(String(err)); this.flushWaiters(); });
  }

  private flushWaiters() {
    const pending = this.waiters.splice(0);
    for (const resolve of pending) resolve();
  }

  private async waitForData(): Promise<void> {
    if (this.buffered || this.ended || this.failure) return;
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  private async ensure(n: number): Promise<void> {
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
        out.set(head, offset);
        offset += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), offset);
        this.chunks[0] = head.slice(need);
        offset += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  static async open(hostname: string, port: number, security: SecurityMode, proxy?: ProxyConfig): Promise<ByteChannel> {
    let socket: AnySocket;
    if (proxy?.mode === 'socks5') {
      socket = await this.openSocks5(hostname, port, proxy);
      const ch = new ByteChannel(socket, hostname);
      if (security === 'tls') await ch.upgradeTls();
      return ch;
    }

    if (security === 'tls') {
      const secure = tls.connect({ host: hostname, port, servername: hostname });
      await waitEvent(secure, 'secureConnect');
      return new ByteChannel(secure, hostname);
    }

    const plain = net.connect({ host: hostname, port });
    await waitEvent(plain, 'connect');
    return new ByteChannel(plain, hostname);
  }

  private static async openSocks5(hostname: string, port: number, proxy: ProxyConfig): Promise<Socket> {
    if (!proxy.host || !proxy.port) throw new Error('SOCKS5 proxy host/port is missing');
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    await waitEvent(socket, 'connect');
    const ch = new ByteChannel(socket, hostname);

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
    if (head[3] === 0x01) await ch.readExact(4 + 2);
    else if (head[3] === 0x04) await ch.readExact(16 + 2);
    else if (head[3] === 0x03) { const len = (await ch.readExact(1))[0]; await ch.readExact(len + 2); }
    else throw new Error('SOCKS5 proxy returned an invalid address type');

    socket.removeAllListeners('data');
    socket.removeAllListeners('end');
    socket.removeAllListeners('close');
    socket.removeAllListeners('error');
    if (ch.buffered) throw new Error('SOCKS5 proxy returned unexpected buffered data');
    return socket;
  }

  async upgradeTls(): Promise<void> {
    if (this.socket instanceof tls.TLSSocket) return;
    const old = this.socket as Socket;
    old.removeAllListeners('data');
    old.removeAllListeners('end');
    old.removeAllListeners('close');
    old.removeAllListeners('error');
    const secure = tls.connect({ socket: old, servername: this.targetHost });
    await waitEvent(secure, 'secureConnect');
    this.socket = secure;
    this.ended = false;
    this.failure = null;
    this.bindSocket(secure);
  }

  async write(data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(bytes, err => err ? reject(err) : resolve());
    });
  }

  async writeLine(line: string): Promise<void> {
    await this.write(`${line}\r\n`);
  }

  async readExact(n: number): Promise<Uint8Array> {
    await this.ensure(n);
    return this.take(n);
  }

  async readLine(): Promise<string> {
    while (true) {
      let offset = 0;
      let prev = -1;
      for (const chunk of this.chunks) {
        for (let i = 0; i < chunk.length; i++, offset++) {
          const b = chunk[i];
          if (prev === 13 && b === 10) {
            const lineBytes = this.take(offset - 1);
            this.take(2);
            return decoder.decode(lineBytes);
          }
          prev = b;
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
