PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mail_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'custom',
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_security TEXT NOT NULL DEFAULT 'tls',
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL DEFAULT 465,
  smtp_security TEXT NOT NULL DEFAULT 'tls',
  username TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_ok_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_mail_accounts_email ON mail_accounts(email);
