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
    } catch { return data; }
  });
}

function parseHeaders(raw: string): Record<string, string> {
  const lines = raw.replace(/\r\n[ \t]+/g, ' ').split(/\r?\n/);
  const h: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).toLowerCase()] = decodeMimeWord(line.slice(i + 1).trim());
  }
  return h;
}

function decodeBody(body: string, encoding: string): string {
  if (/base64/i.test(encoding)) {
    try {
      const clean = body.replace(/\s+/g, '');
      const bin = atob(clean);
      return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } catch { return body; }
  }
  if (/quoted-printable/i.test(encoding)) {
    const joined = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
        bytes.push(parseInt(joined.slice(i + 1, i + 3), 16)); i += 2;
      } else bytes.push(joined.charCodeAt(i) & 0xff);
    }
    try { return new TextDecoder().decode(new Uint8Array(bytes)); } catch { return joined; }
  }
  return body;
}

export function parseMessage(raw: string) {
  const split = raw.search(/\r?\n\r?\n/);
  const rawHeaders = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, '') : '';
  const headers = parseHeaders(rawHeaders);
  const contentType = headers['content-type'] || 'text/plain';
  const transfer = headers['content-transfer-encoding'] || '';
  let text = '';
  let html = '';

  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (/multipart\//i.test(contentType) && boundary) {
    const parts = body.split(`--${boundary}`);
    for (const part of parts) {
      const pSplit = part.search(/\r?\n\r?\n/);
      if (pSplit < 0) continue;
      const ph = parseHeaders(part.slice(0, pSplit));
      const pb = part.slice(pSplit).replace(/^\r?\n\r?\n/, '').replace(/\r?\n--$/, '');
      const pct = ph['content-type'] || 'text/plain';
      const decoded = decodeBody(pb, ph['content-transfer-encoding'] || '');
      if (!html && /^text\/html/i.test(pct)) html = decoded;
      if (!text && /^text\/plain/i.test(pct)) text = decoded;
    }
  } else {
    const decoded = decodeBody(body, transfer);
    if (/^text\/html/i.test(contentType)) html = decoded; else text = decoded;
  }

  if (!text && html) text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    subject: headers.subject || '(No subject)',
    from: headers.from || '',
    to: headers.to || '',
    cc: headers.cc || '',
    date: headers.date || '',
    messageId: headers['message-id'] || '',
    text,
    html
  };
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function encodeHeaderUtf8(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${bytesToB64(new TextEncoder().encode(value))}?=`;
}

export function encodeBodyBase64(value: string): string {
  const b64 = bytesToB64(new TextEncoder().encode(value));
  return b64.match(/.{1,76}/g)?.join('\r\n') || '';
}
