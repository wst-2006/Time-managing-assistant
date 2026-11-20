# Security

Time Managing Assistant is a local-first, single-user application. Everything — the
interface, the local API and the embedded database — runs on your own computer.
The app itself calls no AI service.

## Secrets

The only optional secrets are Feishu app credentials. They live in your local
`.env` (or the desktop app's `.env` in its data folder) and must never be
committed. `.env.example` contains placeholders only.

If a credential is ever committed, revoke or rotate it in the Feishu console
first, then clean the Git history.

## Data

- The data folder and logical backups contain your personal records; do not
  upload them to public places.
- Backups never include Feishu credentials.

## Reporting

Please open a private security advisory on GitHub rather than a public issue.
