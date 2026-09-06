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
