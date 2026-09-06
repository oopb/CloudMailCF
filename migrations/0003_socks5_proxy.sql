ALTER TABLE mail_accounts ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE mail_accounts ADD COLUMN proxy_host TEXT;
ALTER TABLE mail_accounts ADD COLUMN proxy_port INTEGER;
ALTER TABLE mail_accounts ADD COLUMN proxy_username TEXT;
ALTER TABLE mail_accounts ADD COLUMN proxy_password_ciphertext TEXT;
ALTER TABLE mail_accounts ADD COLUMN proxy_password_iv TEXT;
