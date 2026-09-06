# CloudMail CF

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oopb/CloudMailCF)

Cloudflare-native, self-hosted multi-account webmail for accounts you already own.

The goal is simple: add QQ/Gmail/custom IMAP accounts once, then use one CloudMail login on every device without re-entering each mailbox configuration.

## v0.1 features

- Cloudflare Workers + Static Assets + D1; no VPS or Docker required.
- Multiple external IMAP/SMTP accounts.
- Unified inbox across accounts.
- Read recent messages on demand instead of mirroring the entire mailbox.
- Send plain-text mail over SMTP.
- IMAP 993 TLS and STARTTLS support.
- SMTP 465 TLS and 587 STARTTLS support.
- QQ Mail preset.
- Gmail preset for App Passwords.
- Custom IMAP/SMTP preset.
- PWA shell for mobile/home-screen use.
- Single CloudMail admin login with signed HttpOnly session cookie.
- Mail passwords/app-passwords are encrypted with AES-GCM before being stored in D1. The encryption key is a Worker Secret and is not stored in D1.
- Same-origin checks on state-changing API requests.

## Current limitations

This is an MVP, not yet a full replacement for Thunderbird/Spark.

- Gmail OAuth and Microsoft OAuth are not in v0.1. Gmail can be used with an App Password. Modern Microsoft accounts commonly require OAuth, so the Outlook preset is architectural/preparatory and may not authenticate with a normal password.
- The MIME reader handles common text/plain, text/html and simple multipart messages. Deeply nested MIME, inline images and attachments are next-stage work.
- The inbox reads recent messages from the source IMAP servers when requested. It intentionally does not copy all historical mail into D1.
- Folders, archive/delete/move, flags synchronization, search, threads, push notifications and background polling are not implemented yet.
- SMTP port 25 is not supported because Cloudflare Workers blocks outbound TCP connections to port 25. Use 465 or 587.

## Why this architecture

Workers can create outbound TCP sockets, including TLS and STARTTLS. This allows CloudMail to speak IMAP/SMTP directly without a Node.js TCP proxy. The account vault is small and serverless: D1 stores encrypted account configuration while messages remain on their original mail servers.

Cloudflare references:

- https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- https://developers.cloudflare.com/d1/reference/data-security/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/static-assets/

## Deploy

### One-click deployment

Click the button below. Cloudflare will clone the repository, provision the D1 database, ask for the required secrets declared in `.dev.vars.example`, run the D1 migration, and deploy the Worker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oopb/CloudMailCF)

Required secrets during setup:

- `ADMIN_PASSWORD`: the password for the CloudMail web interface.
- `SESSION_SECRET`: a long random value used to sign sessions.
- `CREDENTIAL_KEY`: a different long random value used to encrypt mailbox credentials.

Cloudflare's Deploy button can automatically provision D1 resources declared in `wrangler.jsonc`. The repository's `deploy` script applies migrations using the D1 binding name (`DB`) before deploying.

### Manual deployment

#### 1. Install and log in

```bash
npm install
npx wrangler login
```

#### 2. Create D1

For an Asia-Pacific location hint:

```bash
npx wrangler d1 create cloudmail --location=apac
```

Cloudflare prints a `database_id`. Put it into `wrangler.jsonc` in place of:

```text
00000000-0000-0000-0000-000000000000
```

#### 3. Apply the database migration

```bash
npx wrangler d1 migrations apply DB --remote
```

#### 4. Create three Worker Secrets

Your CloudMail login password:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Generate two independent random values (32+ random bytes is recommended) and save them as:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CREDENTIAL_KEY
```

On Linux/macOS you can generate a value with:

```bash
openssl rand -base64 32
```

Do **not** use the same value for `SESSION_SECRET` and `CREDENTIAL_KEY`.

#### 5. Deploy

```bash
npm run typecheck
npx wrangler deploy
```

Wrangler will print your `*.workers.dev` URL. A custom domain can then be attached from Cloudflare Workers settings.

## QQ Mail

In QQ Mail settings, enable IMAP/SMTP and generate an authorization code/app password. In CloudMail choose **QQ Mail** and use:

- IMAP: `imap.qq.com:993`, TLS
- SMTP: `smtp.qq.com:465`, TLS
- Username: your full QQ email address
- Password: QQ authorization code, not your normal QQ account password

## Gmail

v0.1 uses App Password authentication:

- IMAP: `imap.gmail.com:993`, TLS
- SMTP: `smtp.gmail.com:465`, TLS
- Username: full Gmail address
- Password: Google App Password

OAuth is planned so an App Password will not be required in a later version.

## GitHub Actions

A workflow is included at `.github/workflows/deploy.yml`.

Create repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The three runtime Worker Secrets (`ADMIN_PASSWORD`, `SESSION_SECRET`, `CREDENTIAL_KEY`) should be created with `wrangler secret put` and are retained by Cloudflare across deployments.

## Security model

The server receives mailbox credentials because it must authenticate to external IMAP/SMTP servers. Credentials are encrypted application-side with AES-GCM before D1 storage. D1 also provides encryption at rest, but the extra encryption layer ensures plaintext mailbox credentials are not stored in database rows.

For a production personal deployment:

- use only TLS/STARTTLS mail servers;
- use long unique CloudMail and mailbox app passwords;
- keep the Worker and repository private if you add provider-specific client secrets later;
- protect the custom domain with Cloudflare Access as an optional additional perimeter;
- periodically rotate `ADMIN_PASSWORD`; rotating `CREDENTIAL_KEY` requires re-encrypting saved mailbox credentials, so do not rotate it casually in v0.1.

## Roadmap

1. Google OAuth 2.0 and Microsoft OAuth 2.0/XOAUTH2.
2. Robust MIME parser, attachments and inline images.
3. Folder discovery and archive/delete/move/read/unread operations.
4. D1 metadata cache + UID-based incremental refresh.
5. Cron/Queue new-mail checks and Web Push notifications.
6. Search and conversation threads.
7. Multiple CloudMail users, optional Passkeys/WebAuthn.

## Development

Copy the development variable template:

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply cloudmail --local
npm run dev
```

Note that local Miniflare/Workers development may not perfectly reproduce production outbound TCP behavior. Test real IMAP/SMTP connectivity on a deployed Worker before relying on it.
