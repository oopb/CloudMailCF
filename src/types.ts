export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  CREDENTIAL_KEY: string;
}

export type SecurityMode = 'tls' | 'starttls' | 'plain';

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
