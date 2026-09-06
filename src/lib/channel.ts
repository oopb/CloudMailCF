import { connect, type Socket } from 'cloudflare:sockets';
import type { SecurityMode } from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ByteChannel {
  private socket: Socket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);

  private constructor(socket: Socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  static async open(hostname: string, port: number, security: SecurityMode): Promise<ByteChannel> {
    const secureTransport = security === 'tls' ? 'on' : security === 'starttls' ? 'starttls' : 'off';
    const socket = connect({ hostname, port }, { secureTransport });
    await socket.opened;
    return new ByteChannel(socket);
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

  async writeLine(line: string): Promise<void> {
    await this.write(`${line}\r\n`);
  }

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
