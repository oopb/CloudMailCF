import { ByteChannel } from './channel';
import { encodeBodyBase64, encodeHeaderUtf8 } from './mime';
import type { SecurityMode } from '../types';

export interface SmtpConfig {
  host: string;
  port: number;
  security: SecurityMode;
  username: string;
  password?: string;
  accessToken?: string;
  authType?: 'password' | 'xoauth2';
  from: string;
}

function b64Ascii(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function addr(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1] : value).trim();
}

async function expect(ch: ByteChannel, accepted: number[]): Promise<string[]> {
  const lines: string[] = [];
  while (true) {
    const line = await ch.readLine();
    lines.push(line);
    if (/^\d{3} /.test(line)) {
      const code = Number(line.slice(0, 3));
      if (!accepted.includes(code)) throw new Error(`SMTP error: ${lines.join(' | ')}`);
      return lines;
    }
  }
}

export async function sendMail(cfg: SmtpConfig, to: string, subject: string, text: string): Promise<void> {
  if (cfg.port === 25) throw new Error('Cloudflare Workers blocks outbound SMTP port 25; use 465 or 587.');
  const ch = await ByteChannel.open(cfg.host, cfg.port, cfg.security);
  try {
    await expect(ch, [220]);
    await ch.writeLine('EHLO cloudmail.local');
    await expect(ch, [250]);

    if (cfg.security === 'starttls') {
      await ch.writeLine('STARTTLS');
      await expect(ch, [220]);
      await ch.upgradeTls();
      await ch.writeLine('EHLO cloudmail.local');
      await expect(ch, [250]);
    }

    if (cfg.authType === 'xoauth2') {
      if (!cfg.accessToken) throw new Error('SMTP XOAUTH2 access token is missing');
      const sasl = b64Ascii(`user=${cfg.username}\x01auth=Bearer ${cfg.accessToken}\x01\x01`);
      await ch.writeLine(`AUTH XOAUTH2 ${sasl}`);
      await expect(ch, [235]);
    } else {
      if (!cfg.password) throw new Error('SMTP password is missing');
      await ch.writeLine('AUTH LOGIN');
      await expect(ch, [334]);
      await ch.writeLine(b64Ascii(cfg.username));
      await expect(ch, [334]);
      await ch.writeLine(b64Ascii(cfg.password));
      await expect(ch, [235]);
    }

    await ch.writeLine(`MAIL FROM:<${addr(cfg.from)}>`);
    await expect(ch, [250]);
    for (const recipient of to.split(',').map(addr).filter(Boolean)) {
      await ch.writeLine(`RCPT TO:<${recipient}>`);
      await expect(ch, [250, 251]);
    }
    await ch.writeLine('DATA');
    await expect(ch, [354]);

    const messageId = `<${crypto.randomUUID()}@cloudmail.local>`;
    const body = encodeBodyBase64(text).replace(/^\./gm, '..');
    const raw = [
      `From: ${cfg.from}`,
      `To: ${to}`,
      `Subject: ${encodeHeaderUtf8(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
      '.'
    ].join('\r\n');
    await ch.write(`${raw}\r\n`);
    await expect(ch, [250]);
    await ch.writeLine('QUIT');
    await expect(ch, [221]);
  } finally {
    await ch.close();
  }
}
