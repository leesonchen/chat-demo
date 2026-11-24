# Chat Demo account and cloud backup service

The backend is intentionally small and uses Node.js built-ins, including `node:sqlite`. It does not proxy DeepSeek chat requests. The browser continues to call the configured DeepSeek API directly.

## Requirements

- Node.js 22.12 or newer. `node:sqlite` is experimental in this Node release line, so the start command enables it explicitly.
- A WeChat Open Platform website application with website QR login enabled.
- A public HTTPS origin for production.

## Configure

1. Copy `server/.env.example` to `server/.env`.
2. Set `APP_ORIGIN` to the exact frontend origin, without a trailing path.
3. Set `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and the exact callback URL in `WECHAT_REDIRECT_URI`.
4. Configure the callback domain in the WeChat Open Platform website application.
5. Generate `API_KEY_ENCRYPTION_KEY` with `openssl rand -base64 32`.
6. Keep the encryption key separate from the SQLite database. Losing it makes stored API keys unrecoverable.

## Run

```sh
pnpm server
```

The API listens on `127.0.0.1:8091` by default. Configure the frontend reverse proxy to send `/api/` to this service. The development Rspack server proxies `/api/` to `http://localhost:8091`.

## Tests

```sh
pnpm server:test
```

## Data and behavior

- SQLite database: `DATA_DIR/chat-demo.sqlite`.
- Cloud backups: `DATA_DIR/backups/`, one ZIP snapshot per user. A new export replaces that user's previous snapshot.
- The backup reuses the existing chat-demo ZIP format. It contains all conversation branches and locally available image originals. Other attachment types retain metadata only, matching the existing local ZIP export behavior.
- Restoring a cloud backup replaces the current device's local history through the existing staged import path. It does not merge histories.
- API keys are encrypted at rest with AES-256-GCM. They are not included in chat backup ZIP files or request logs. After login, the browser retrieves its own decrypted key over the authenticated HTTPS session so the existing direct-to-DeepSeek client continues to work.
- Sessions use random opaque tokens in HttpOnly, SameSite=Lax cookies; only token hashes are stored in SQLite. State-changing browser requests require the configured `APP_ORIGIN` Origin header.
- The OAuth identity table is provider-based so a future QQ identity can be added without changing the user primary key. Only WeChat is enabled in this version.

Back up the SQLite database and the `backups` directory together. Back up `API_KEY_ENCRYPTION_KEY` separately and securely. Do not commit `.env` or runtime data.
