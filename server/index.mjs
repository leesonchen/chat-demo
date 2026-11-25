import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from './database.mjs'
import { createAppServer } from './app.mjs'
import { parseEncryptionKey } from './security.mjs'

process.umask(0o077)

const root = path.dirname(fileURLToPath(import.meta.url))
const appOrigin = new URL(process.env.APP_ORIGIN ?? 'http://localhost:8090').origin
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'))
const production = process.env.NODE_ENV === 'production'
if (production && !appOrigin.startsWith('https://')) {
  throw new Error('APP_ORIGIN must use HTTPS in production')
}

const readWechatAuth = () => {
  const {
    AUTH_SERVICE_ORIGIN: origin,
    AUTH_CLIENT_ID: clientId,
    AUTH_CLIENT_SECRET: clientSecret,
    WECHAT_APP_ID: wechatAppId,
  } = process.env
  if (!origin && !clientId && !clientSecret) return null

  const url = URL.parse(origin ?? '')
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
  const local = !production && url?.protocol === 'http:' && loopback.has(url.hostname)
  if (!url || url.origin !== origin || (url.protocol !== 'https:' && !local) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(clientId ?? '') ||
      !/^[A-Za-z0-9._~-]{32,256}$/.test(clientSecret ?? '') ||
      !/^wx[a-f0-9]{16}$/i.test(wechatAppId ?? '')) {
    throw new Error('WeChat login needs a valid AUTH_SERVICE_ORIGIN, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, and WECHAT_APP_ID')
  }
  return { origin, clientId, clientSecret, wechatAppId }
}
const wechatAuth = readWechatAuth()
const membershipMode = process.env.MEMBERSHIP_MODE ?? 'off'
if (!['off', 'preview', 'required'].includes(membershipMode)) {
  throw new Error('MEMBERSHIP_MODE must be off, preview, or required')
}
const encryptionKey = parseEncryptionKey(process.env.API_KEY_ENCRYPTION_KEY)
const db = createDatabase(path.join(dataDir, 'chat-demo.sqlite'))
const server = createAppServer({
  db,
  config: {
    appOrigin,
    backupDir: path.join(dataDir, 'backups'),
    encryptionKey,
    secureCookies: production,
    wechatAuth,
    membershipMode,
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
