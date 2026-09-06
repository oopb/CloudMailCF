# CloudMail CF

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oopb/CloudMailCF)

Cloudflare-native, self-hosted multi-account webmail for accounts you already own.

The goal is simple: add QQ/Gmail/Outlook/custom IMAP accounts once, then use one CloudMail login on every device without re-entering each mailbox configuration.

## v0.2 features

- Cloudflare Workers + Static Assets + D1; no VPS or Docker required.
- Multiple external IMAP/SMTP accounts.
- Unified inbox across accounts.
- Read recent messages on demand instead of mirroring the entire mailbox.
- Send plain-text mail over SMTP.
- IMAP 993 TLS and STARTTLS support.
- SMTP 465 TLS and 587 STARTTLS support.
- QQ Mail preset.
- Gmail preset for App Passwords.
- Outlook.com / Microsoft 365 OAuth 2.0 + XOAUTH2.
- Automatic Microsoft refresh-token rotation and access-token refresh.
- Custom IMAP/SMTP preset.
- PWA shell for mobile/home-screen use.
- Single CloudMail admin login with signed HttpOnly session cookie.
- Mail passwords/app-passwords/OAuth refresh tokens are encrypted with AES-GCM before being stored in D1. The encryption key is a Worker Secret and is not stored in D1.
- Same-origin checks on state-changing API requests and one-time D1 OAuth state records.

## Current limitations

This is still an MVP, not yet a full replacement for Thunderbird/Spark.

- Gmail OAuth is not implemented yet. Gmail can currently be used with an App Password.
- Microsoft OAuth requires you to create your own Microsoft Entra application and configure its client ID/secret.
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

Microsoft references:

- https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow

## Deploy

### One-click deployment

Click the button below. Cloudflare will clone the repository and provision the D1 database declared in `wrangler.jsonc`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oopb/CloudMailCF)

Required Cloudflare runtime secrets:

- `ADMIN_PASSWORD`: password for the CloudMail web interface.
- `SESSION_SECRET`: long random value used to sign sessions.
- `CREDENTIAL_KEY`: a different long random value used to encrypt mailbox credentials and OAuth refresh tokens.

Optional Microsoft OAuth variables (required only for Outlook/Microsoft 365):

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET` (Secret)
- `MICROSOFT_TENANT` (use `common` for personal + multi-tenant organizational accounts)

The repository's `deploy` script runs `wrangler deploy` first so Cloudflare can provision the D1 binding, then applies all D1 migrations.

### Cloudflare Workers Builds

When importing this GitHub repository from the Cloudflare dashboard, use:

```text
Build command:  npm run typecheck
Deploy command: npm run deploy
```

Root directory can stay `/` / repository root.

### Manual deployment

```bash
npm install
npx wrangler login
npm run typecheck
npm run deploy
```

If you prefer to create the D1 database manually, create it with Wrangler and then add the returned `database_id` to `wrangler.jsonc`. For normal Workers Builds / Deploy Button usage, leave `database_id` out and let Cloudflare provision the binding.

Create the three core Worker secrets:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CREDENTIAL_KEY
```

On Linux/macOS you can generate random values with:

```bash
openssl rand -base64 32
```

Do **not** use the same value for `SESSION_SECRET` and `CREDENTIAL_KEY`.

## QQ Mail

In QQ Mail settings, enable IMAP/SMTP and generate an authorization code/app password. In CloudMail choose **QQ Mail** and use:

- IMAP: `imap.qq.com:993`, TLS
- SMTP: `smtp.qq.com:465`, TLS
- Username: your full QQ email address
- Password: QQ authorization code, not your normal QQ account password

## Gmail

The current Gmail path uses App Password authentication:

- IMAP: `imap.gmail.com:993`, TLS
- SMTP: `smtp.gmail.com:465`, TLS
- Username: full Gmail address
- Password: Google App Password

Google OAuth is planned.

## Outlook / Microsoft 365 OAuth

Microsoft has disabled Basic Authentication for modern Exchange Online IMAP/SMTP scenarios. CloudMail therefore uses OAuth 2.0 authorization-code flow and XOAUTH2 for Microsoft accounts.

### 1. Register an application in Microsoft Entra

Go to Microsoft Entra admin center / App registrations and create an application.

Recommended supported account type if you want both personal Outlook.com and organization accounts:

```text
Accounts in any organizational directory and personal Microsoft accounts
```

Copy the **Application (client) ID**.

### 2. Add the Web redirect URI

Add a **Web** redirect URI matching your deployed CloudMail origin exactly:

```text
https://YOUR-CLOUDMAIL-DOMAIN/api/oauth/microsoft/callback
```

Examples:

```text
https://cloudmail-cf.example.workers.dev/api/oauth/microsoft/callback
https://mail.example.com/api/oauth/microsoft/callback
```

If you later change from workers.dev to a custom domain, add the new callback URI in Entra too.

### 3. Add delegated permissions

CloudMail requests these Microsoft delegated scopes:

```text
offline_access
https://outlook.office.com/IMAP.AccessAsUser.All
https://outlook.office.com/SMTP.Send
```

It also requests `openid profile email` to identify the signed-in mailbox.

Depending on your organization tenant policy, an administrator may need to grant consent.

### 4. Create a client secret

In **Certificates & secrets**, create a client secret and copy its value immediately.

### 5. Add Cloudflare variables/secrets

In the Worker settings add:

```text
MICROSOFT_CLIENT_ID=<Application client ID>
MICROSOFT_CLIENT_SECRET=<Client secret value>
MICROSOFT_TENANT=common
```

`MICROSOFT_CLIENT_SECRET` should be stored as a Cloudflare **Secret**. `MICROSOFT_CLIENT_ID` and `MICROSOFT_TENANT` may be normal text variables.

If you only want accounts from one Entra tenant, set `MICROSOFT_TENANT` to that tenant ID instead of `common`.

### 6. Add the account in CloudMail

Open **Add mailbox → Outlook / Microsoft 365**, enter a label and email address, then click:

```text
使用 Microsoft 登录并授权
```

After Microsoft redirects back, CloudMail encrypts the refresh token with `CREDENTIAL_KEY`. The Microsoft password is never stored.

For IMAP, CloudMail sends SASL XOAUTH2 using the access token. For SMTP AUTH, CloudMail uses XOAUTH2 after STARTTLS on port 587.

## GitHub Actions

A workflow is included at `.github/workflows/deploy.yml`.

Without GitHub Cloudflare secrets it performs install + typecheck only and safely skips deployment. To deploy automatically from GitHub Actions, create repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Runtime Worker secrets are configured in Cloudflare and retained across deployments.

## Security model

The server must possess either mailbox app-passwords or OAuth refresh tokens so it can authenticate to external mail servers. Those credentials are encrypted application-side with AES-GCM before D1 storage. D1 also provides encryption at rest, but CloudMail does not store plaintext mailbox credentials in database rows.

For Microsoft OAuth, the authorization `state` value is a random one-time record stored in D1 and expires after 15 minutes. OAuth refresh tokens are encrypted with the same `CREDENTIAL_KEY` vault mechanism used for app-passwords.

For a production personal deployment:

- use only TLS/STARTTLS mail servers;
- use long unique CloudMail and mailbox app passwords;
- store `ADMIN_PASSWORD`, `SESSION_SECRET`, `CREDENTIAL_KEY`, and `MICROSOFT_CLIENT_SECRET` as Cloudflare Secrets;
- optionally protect the custom domain with Cloudflare Access;
- rotating `CREDENTIAL_KEY` requires re-encrypting saved credentials, so do not rotate it casually until an automated rotation tool exists.

## Roadmap

1. Google OAuth 2.0 / XOAUTH2.
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
