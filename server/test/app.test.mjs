import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDatabase } from '../database.mjs'
import { createAppServer } from '../app.mjs'
import { sha256 } from '../security.mjs'

const makeServer = async (options = {}) => {
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
      secureCookies: Boolean(options.secureCookies),
      wechatAuth: options.wechatAuth,
    },
    fetchImpl: options.fetchImpl,
    now: options.now,
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

const appOrigin = 'http://localhost:8090'
const callbackPath = '/api/auth/wechat/callback'
const wechatAuth = {
  origin: 'https://auth.example.com',
  clientId: 'chat-demo',
  clientSecret: 'fixture-client-secret',
  wechatAppId: 'wx0123456789abcdef',
}
const cookiePair = value => value.split(';')[0]

const startLogin = app => fetch(app.baseUrl + '/api/auth/wechat/start', {
  method: 'POST',
  headers: { origin: appOrigin },
})

test('WeChat login start requires its configured identity service and the app origin', async (t) => {
  const app = await makeServer()
  t.after(app.close)
  assert.equal((await startLogin(app)).status, 503)
  const crossOrigin = await fetch(app.baseUrl + '/api/auth/wechat/start', {
    method: 'POST', headers: { origin: 'https://other.example.com' },
  })
  assert.equal(crossOrigin.status, 403)
})

test('delegated login restores the existing account, profile, API Key and cloud backup', async (t) => {
  let authorize
  let exchanged = 0
  const code = 'C'.repeat(43)
  const app = await makeServer({
    wechatAuth,
    secureCookies: true,
    fetchImpl: async (input, request) => {
      exchanged++
      assert.equal(input.href, wechatAuth.origin + '/exchange')
      assert.equal(request.redirect, 'error')
      assert.equal(request.headers.Authorization,
        'Basic ' + Buffer.from(wechatAuth.clientId + ':' + wechatAuth.clientSecret).toString('base64'))
      const body = JSON.parse(request.body)
      assert.equal(body.code, code)
      assert.equal(body.redirect_uri, appOrigin + callbackPath)
      assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'),
        authorize.searchParams.get('code_challenge'))
      return Response.json({ appid: wechatAuth.wechatAppId, openid: 'existing-openid' })
    },
  })
  t.after(app.close)
  const current = Date.now()
  const avatar = 'https://thirdwx.qlogo.cn/mmopen/example/132'
  app.db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatar, app.userId)
  app.db.prepare(`INSERT INTO oauth_identities (id, user_id, provider, openid, unionid, created_at, updated_at)
    VALUES (?, ?, 'wechat', 'existing-openid', 'old-unionid', ?, ?)`).run(randomUUID(), app.userId, current, current)
  const oldSession = 'chat_demo_session=' + app.token
  const apiKey = 'sk-previous-key'
  const backup = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02])
  const put = (path, contentType, body) => fetch(app.baseUrl + path, {
    method: 'PUT', headers: { Cookie: oldSession, Origin: appOrigin, 'Content-Type': contentType }, body,
  })
  assert.equal((await put('/api/account/api-key', 'application/json', JSON.stringify({ apiKey }))).status, 200)
  assert.equal((await put('/api/backup', 'application/zip', backup)).status, 200)

  const start = await startLogin(app)
  assert.equal(start.status, 200)
  const loginCookie = start.headers.get('set-cookie')
  assert.match(loginCookie, /HttpOnly; Path=\/api\/auth\/wechat\/callback; SameSite=Lax; Max-Age=600; Secure/)
  authorize = new URL((await start.json()).authorizeUrl)
  assert.equal(authorize.origin + authorize.pathname, wechatAuth.origin + '/authorize')
  assert.equal(authorize.searchParams.get('client_id'), wechatAuth.clientId)
  assert.equal(authorize.searchParams.get('redirect_uri'), appOrigin + callbackPath)
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')

  const state = authorize.searchParams.get('state')
  const callback = (cookie, receivedState = state) => fetch(
    app.baseUrl + callbackPath + '?' + new URLSearchParams({ code, state: receivedState }),
    { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} },
  )
  for (const options of [[], ['chat_demo_wechat_login=' + 'x'.repeat(43)], [cookiePair(loginCookie), 's'.repeat(43)]]) {
    const failed = await callback(...options)
    assert.equal(failed.headers.get('location'), '/?wechat_login=failed')
    assert.equal(failed.headers.get('set-cookie'), null)
  }
  assert.equal(exchanged, 0)

  const valid = await callback(cookiePair(loginCookie))
  assert.equal(valid.status, 303)
  assert.equal(valid.headers.get('location'), '/?wechat_login=ok')
  assert.equal(valid.headers.get('referrer-policy'), 'no-referrer')
  const [session, cleared] = valid.headers.getSetCookie()
  assert.match(session, /^chat_demo_session=[^;]+; HttpOnly; Path=\/; SameSite=Lax; Max-Age=\d+; Secure$/)
  assert.match(cleared, /chat_demo_wechat_login=;.*Max-Age=0/)
  assert.equal((await callback(cookiePair(loginCookie))).headers.get('location'), '/?wechat_login=failed')
  assert.equal(exchanged, 1)

  const get = path => fetch(app.baseUrl + path, { headers: { Cookie: cookiePair(session) } })
  assert.deepEqual(await (await get('/api/auth/me')).json(), {
    user: { id: app.userId, nickname: 'Test User', avatarUrl: avatar },
  })
  assert.deepEqual(await (await get('/api/account/api-key')).json(), { apiKey })
  assert.deepEqual(Buffer.from(await (await get('/api/backup')).arrayBuffer()), backup)
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 1)
  assert.equal(app.db.prepare('SELECT unionid FROM oauth_identities').get().unionid, 'old-unionid')
})

test('expired state and identities from another WeChat AppID do not create sessions', async (t) => {
  let clock = Date.now()
  let exchanged = 0
  const app = await makeServer({
    wechatAuth,
    now: () => clock,
    fetchImpl: async () => {
      exchanged++
      return Response.json({ appid: 'wx1111111111111111', openid: 'other-openid' })
    },
  })
  t.after(app.close)
  const begin = async () => {
    const response = await startLogin(app)
    const cookie = cookiePair(response.headers.get('set-cookie'))
    const state = new URL((await response.json()).authorizeUrl).searchParams.get('state')
    return () => fetch(app.baseUrl + callbackPath + '?' + new URLSearchParams({ code: 'C'.repeat(43), state }), {
      redirect: 'manual', headers: { Cookie: cookie },
    })
  }

  const expired = await begin()
  clock += 10 * 60 * 1000
  assert.equal((await expired()).headers.get('location'), '/?wechat_login=failed')
  assert.equal(exchanged, 0)

  const wrongApp = await begin()
  const result = await wrongApp()
  assert.equal(result.headers.get('location'), '/?wechat_login=failed')
  assert.equal(exchanged, 1)
  assert.ok(result.headers.getSetCookie().every(cookie => !cookie.startsWith('chat_demo_session=')))
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 1)
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM sessions').get().count, 1)
})
