import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from './database.mjs'
import { createAppServer } from './app.mjs'
import { parseEncryptionKey } from './security.mjs'

process.umask(0o077)

const root = path.dirname(fileURLToPath(import.meta.url))
const appOrigin = new URL(process.env.APP_ORIGIN ?? 'http://localhost:8090').origin
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'))
const redirectUri = process.env.WECHAT_REDIRECT_URI ?? `${appOrigin}/api/auth/wechat/callback`
const encryptionKey = parseEncryptionKey(process.env.API_KEY_ENCRYPTION_KEY)
const db = createDatabase(path.join(dataDir, 'chat-demo.sqlite'))
const server = createAppServer({
  db,
  config: {
    appOrigin,
    backupDir: path.join(dataDir, 'backups'),
    encryptionKey,
    secureCookies: process.env.NODE_ENV === 'production',
    wechatAppId: process.env.WECHAT_APP_ID ?? '',
    wechatAppSecret: process.env.WECHAT_APP_SECRET ?? '',
    wechatRedirectUri: redirectUri,
  },
})

const port = Number(process.env.PORT ?? 8091)
const host = process.env.HOST ?? '127.0.0.1'
server.listen(port, host, () => {
  process.stdout.write(`[chat-demo-server] listening on ${host}:${port}\n`)
})

const shutdown = () => {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
