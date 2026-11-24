import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { createDatabase } from '../database.mjs'
import { createAppServer } from '../app.mjs'
import { sha256 } from '../security.mjs'

const makeServer = async () => {
  const db = createDatabase(':memory:')
  const now = Date.now()
  const userId = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const key = randomBytes(32)
  db.prepare('INSERT INTO users (id, nickname, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'Test User', now, now)
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now + 60_000, now)
  const backupDir = `/tmp/chat-demo-backup-test-${randomUUID()}`
  const server = createAppServer({
    db,
    config: {
      appOrigin: 'http://localhost:8090',
      backupDir,
      encryptionKey: key,
      secureCookies: false,
      wechatAppId: '',
      wechatAppSecret: '',
      wechatRedirectUri: '',
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    db,
    key,
    token,
    userId,
    server,
    backupDir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      db.close()
      const { rm } = await import('node:fs/promises')
      await rm(backupDir, { recursive: true, force: true })
    },
  }
}

test('account API key is authenticated, encrypted at rest, and scoped to the user', async (t) => {
  const app = await makeServer()
  t.after(app.close)
  const cookie = `chat_demo_session=${app.token}`
  const origin = 'http://localhost:8090'

  const unauthorized = await fetch(`${app.baseUrl}/api/account/api-key`)
  assert.equal(unauthorized.status, 401)

  const saved = await fetch(`${app.baseUrl}/api/account/api-key`, {
    method: 'PUT',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-test-api-key' }),
  })
  assert.equal(saved.status, 200)

  const row = app.db.prepare('SELECT ciphertext, iv, auth_tag FROM user_secrets WHERE user_id = ?').get(app.userId)
  assert.ok(row)
  assert.notEqual(row.ciphertext, Buffer.from('sk-test-api-key').toString('base64'))

  const restored = await fetch(`${app.baseUrl}/api/account/api-key`, { headers: { cookie } })
  assert.deepEqual(await restored.json(), { apiKey: 'sk-test-api-key' })

  const otherUserId = randomUUID()
  const otherToken = randomBytes(32).toString('base64url')
  app.db.prepare('INSERT INTO users (id, nickname, created_at, updated_at) VALUES (?, ?, ?, ?)').run(otherUserId, 'Other User', Date.now(), Date.now())
  app.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(otherToken), otherUserId, Date.now() + 60_000, Date.now())
  const otherKey = await fetch(`${app.baseUrl}/api/account/api-key`, { headers: { cookie: `chat_demo_session=${otherToken}` } })
  assert.deepEqual(await otherKey.json(), { apiKey: null })

  const csrf = await fetch(`${app.baseUrl}/api/account/api-key`, {
    method: 'PUT',
    headers: { cookie, origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-attacker-key' }),
  })
  assert.equal(csrf.status, 403)
})

test('cloud backup replaces one user snapshot and can be restored', async (t) => {
  const app = await makeServer()
  t.after(app.close)
  const cookie = `chat_demo_session=${app.token}`
  const origin = 'http://localhost:8090'
  const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02])

  const upload = await fetch(`${app.baseUrl}/api/backup`, {
    method: 'PUT',
    headers: { cookie, origin, 'content-type': 'application/zip' },
    body: archive,
  })
  assert.equal(upload.status, 200)

  const status = await fetch(`${app.baseUrl}/api/backup/status`, { headers: { cookie } })
  const info = await status.json()
  assert.equal(info.exists, true)
  assert.equal(info.byteSize, archive.length)

  const download = await fetch(`${app.baseUrl}/api/backup`, { headers: { cookie } })
  assert.equal(download.status, 200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), archive)

  const missingForOtherUser = await fetch(`${app.baseUrl}/api/backup/status`)
  assert.equal(missingForOtherUser.status, 401)
})

test('WeChat login start refuses to run until credentials are configured', async (t) => {
  const app = await makeServer()
  t.after(app.close)
  const response = await fetch(`${app.baseUrl}/api/auth/wechat/start`)
  assert.equal(response.status, 503)
})
