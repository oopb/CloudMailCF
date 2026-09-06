export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  CREDENTIAL_KEY: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT?: string;
}

export type SecurityMode = 'tls' | 'starttls' | 'plain';
export type AuthType = 'password' | 'oauth_microsoft';
export type ProxyMode = 'direct' | 'socks5' | 'shadowsocks';
export type ShadowsocksMethod =
  | 'aes-128-gcm'
  | 'aes-256-gcm'
  | 'chacha20-ietf-poly1305'
  | '2022-blake3-aes-128-gcm'
  | '2022-blake3-aes-256-gcm'
  | '2022-blake3-chacha20-poly1305'
  | '2022-blake3-chacha8-poly1305';

export interface ProxyConfig {
  mode: ProxyMode;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  ssMethod?: ShadowsocksMethod;
}

export interface MailAccountInput {
  label: string;
  email: string;
  provider?: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: SecurityMode;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SecurityMode;
  username: string;
  password: string;
  proxyMode?: ProxyMode;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  proxyMethod?: ShadowsocksMethod;
}

export interface StoredAccount {
  id: string;
  label: string;
  email: string;
  provider: string;
  auth_type: AuthType;
  imap_host: string;
  imap_port: number;
  imap_security: SecurityMode;
  smtp_host: string;
  smtp_port: number;
  smtp_security: SecurityMode;
  username: string;
  credential_ciphertext: string;
  credential_iv: string;
  proxy_mode: ProxyMode | null;
  proxy_host: string | null;
  proxy_port: number | null;
  proxy_username: string | null;
  proxy_password_ciphertext: string | null;
  proxy_password_iv: string | null;
  proxy_method: ShadowsocksMethod | null;
  created_at: string;
  updated_at: string;
  last_ok_at: string | null;
  last_error: string | null;
}

export interface OAuthStateRow {
  state: string;
  provider: string;
  label: string;
  email: string;
  redirect_uri: string;
  created_at: string;
}
