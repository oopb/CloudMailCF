import { ByteChannel } from './channel';
import type { SecurityMode } from '../types';

const decoder = new TextDecoder();

export interface ImapConfig {
  host: string;
  port: number;
  security: SecurityMode;
  username: string;
  password: string;
}

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string;
  messageId: string;
  flags: string[];
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function decodeMimeWord(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset, mode, data) => {
    try {
      let bytes: Uint8Array;
      if (String(mode).toUpperCase() === 'B') {
        const bin = atob(data);
        bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      } else {
        const q = String(data).replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(q, c => c.charCodeAt(0));
      }
      return new TextDecoder(String(charset).toLowerCase()).decode(bytes);
    } catch {
      return data;
    }
  });
}

function unfoldHeaders(raw: string): Record<string, string> {
  const lines = raw.replace(/\r\n[ \t]+/g, ' ').split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    headers[key] = decodeMimeWord(line.slice(idx + 1).trim());
  }
  return headers;
}

function parseFlags(line: string): string[] {
  const m = line.match(/FLAGS \(([^)]*)\)/i);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

class ImapClient {
  private ch!: ByteChannel;
  private tagNo = 1;

  constructor(private cfg: ImapConfig) {}

  private tag(): string { return `A${String(this.tagNo++).padStart(4, '0')}`; }

  async connect(): Promise<void> {
    this.ch = await ByteChannel.open(this.cfg.host, this.cfg.port, this.cfg.security);
    const greeting = await this.ch.readLine();
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error(`IMAP greeting rejected: ${greeting}`);

    if (this.cfg.security === 'starttls') {
      const tag = this.tag();
      await this.ch.writeLine(`${tag} STARTTLS`);
      const lines = await this.readTagged(tag);
      if (!lines.at(-1)?.startsWith(`${tag} OK`)) throw new Error(`IMAP STARTTLS failed: ${lines.at(-1)}`);
      await this.ch.upgradeTls();
    }

    const tag = this.tag();
    await this.ch.writeLine(`${tag} LOGIN ${quote(this.cfg.username)} ${quote(this.cfg.password)}`);
    const lines = await this.readTagged(tag);
    if (!lines.at(-1)?.startsWith(`${tag} OK`)) throw new Error(`IMAP login failed: ${lines.at(-1)}`);
  }

  private async readTagged(tag: string): Promise<string[]> {
    const out: string[] = [];
    while (true) {
      const line = await this.ch.readLine();
      out.push(line);
      if (line.startsWith(`${tag} `)) return out;
    }
  }

  private async simple(command: string): Promise<string[]> {
    const tag = this.tag();
    await this.ch.writeLine(`${tag} ${command}`);
    const lines = await this.readTagged(tag);
    if (!lines.at(-1)?.startsWith(`${tag} OK`)) throw new Error(`IMAP command failed (${command}): ${lines.at(-1)}`);
    return lines;
  }

  async selectInbox(): Promise<void> {
    await this.simple('SELECT INBOX');
  }

  async recent(limit = 20): Promise<MailSummary[]> {
    await this.selectInbox();
    const search = await this.simple('UID SEARCH ALL');
    const searchLine = search.find(l => /^\* SEARCH(?: |$)/i.test(l)) || '* SEARCH';
    const uids = searchLine.slice(8).trim().split(/\s+/).map(Number).filter(Number.isFinite);
    const selected = uids.slice(-Math.max(1, Math.min(limit, 50)));
    if (!selected.length) return [];

    const tag = this.tag();
    await this.ch.writeLine(`${tag} UID FETCH ${selected.join(',')} (UID FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE MESSAGE-ID)])`);

    const messages: MailSummary[] = [];
    let pendingLine = '';
    while (true) {
      const line = await this.ch.readLine();
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) throw new Error(`IMAP fetch failed: ${line}`);
        break;
      }
      if (/^\* \d+ FETCH /i.test(line)) pendingLine = line;
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) {
        const n = Number(lit[1]);
        const rawHeaders = decoder.decode(await this.ch.readExact(n));
        const headers = unfoldHeaders(rawHeaders);
        const uidMatch = pendingLine.match(/UID (\d+)/i);
        if (uidMatch) {
          messages.push({
            uid: Number(uidMatch[1]),
            subject: headers.subject || '(No subject)',
            from: headers.from || '',
            to: headers.to || '',
            date: headers.date || '',
            messageId: headers['message-id'] || '',
            flags: parseFlags(pendingLine)
          });
        }
      }
    }
    return messages;
  }

  async fetchRaw(uid: number): Promise<string> {
    await this.selectInbox();
    const tag = this.tag();
    await this.ch.writeLine(`${tag} UID FETCH ${uid} (BODY.PEEK[])`);
    let raw = '';
    while (true) {
      const line = await this.ch.readLine();
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) throw new Error(`IMAP fetch failed: ${line}`);
        break;
      }
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) raw = decoder.decode(await this.ch.readExact(Number(lit[1])));
    }
    if (!raw) throw new Error('Message body was not returned by the IMAP server');
    return raw;
  }

  async close(): Promise<void> {
    try { await this.simple('LOGOUT'); } catch {}
    await this.ch.close();
  }
}

export async function withImap<T>(cfg: ImapConfig, fn: (client: ImapClient) => Promise<T>): Promise<T> {
  const client = new ImapClient(cfg);
  await client.connect();
  try { return await fn(client); } finally { await client.close(); }
}
