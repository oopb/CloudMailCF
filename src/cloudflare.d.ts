interface D1Result<T = unknown> {
  results: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
interface ExportedHandler<Env = unknown> {
  fetch?: (request: Request, env: Env, ctx?: ExecutionContext) => Response | Promise<Response>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

declare module 'cloudflare:sockets' {
  export interface SocketInfo { remoteAddress: string | null; localAddress: string | null; }
  export interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    opened: Promise<SocketInfo>;
    closed: Promise<void>;
    close(): Promise<void>;
    startTls(): Socket;
  }
  export function connect(
    address: { hostname: string; port: number } | string,
    options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean }
  ): Socket;
}
