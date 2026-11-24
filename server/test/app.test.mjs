import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { createDatabase, migrateDatabase } from '../database.mjs'
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
      secureCookies: false,
      wechatAppId: options.wechatAppId ?? '',
      wechatAppSecret: options.wechatAppSecret ?? '',
      wechatRedirectUri: options.wechatRedirectUri ?? '',
    },
    fetchImpl: options.fetchImpl,
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
  const response = await fetch(`${app.baseUrl}/api/auth/wechat/start`, {
    method: 'POST',
    headers: { origin: 'http://localhost:8090' },
  })
  assert.equal(response.status, 503)
})

test('WeChat Official Account QR login completes through a one-time browser polling ticket', async (t) => {
  let wechatCalls = 0
  const app = await makeServer({
    wechatAppId: 'wx-test-app',
    wechatAppSecret: 'test-secret',
    wechatRedirectUri: 'http://localhost:8090/api/auth/wechat/callback',
    fetchImpl: async (input) => {
      wechatCalls += 1
      const url = new URL(input)
      assert.equal(url.pathname, '/sns/oauth2/access_token')
      assert.equal(url.searchParams.get('appid'), 'wx-test-app')
      assert.equal(url.searchParams.get('secret'), 'test-secret')
      return {
        ok: true,
        json: async () => ({
          access_token: 'wechat-web-access-token',
          openid: 'wechat-openid',
          unionid: 'wechat-unionid',
        }),
      }
    },
  })
  t.after(app.close)

  const origin = 'http://localhost:8090'
  const start = await fetch(`${app.baseUrl}/api/auth/wechat/start`, { method: 'POST', headers: { origin: 'http://localhost:8090' } })
  assert.equal(start.status, 200)
  const challenge = await start.json()
  assert.ok(challenge.ticket)
  assert.ok(challenge.pollSecret)
  assert.equal(challenge.expiresIn, 600)

  const authorize = new URL(challenge.authorizeUrl)
  const state = authorize.searchParams.get('state')
  assert.equal(authorize.origin, 'https://open.weixin.qq.com')
  assert.equal(authorize.pathname, '/connect/oauth2/authorize')
  assert.equal(authorize.searchParams.get('appid'), 'wx-test-app')
  assert.equal(authorize.searchParams.get('scope'), 'snsapi_base')
  assert.equal(authorize.searchParams.get('response_type'), 'code')
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:8090/api/auth/wechat/callback')
  assert.equal(authorize.hash, '#wechat_redirect')

  const pending = await fetch(`${app.baseUrl}/api/auth/wechat/poll`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: challenge.ticket, pollSecret: challenge.pollSecret }),
  })
  assert.deepEqual(await pending.json(), { status: 'pending' })

  const forgedPoll = await fetch(`${app.baseUrl}/api/auth/wechat/poll`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: challenge.ticket, pollSecret: 'wrong-secret' }),
  })
  assert.equal(forgedPoll.status, 404)

  const callback = await fetch(`${app.baseUrl}/api/auth/wechat/callback?code=single-use-code&state=${state}`)
  assert.equal(callback.status, 200)
  assert.match(await callback.text(), /微信身份验证成功/)
  assert.equal(wechatCalls, 1)

  const identity = app.db.prepare("SELECT user_id, unionid FROM oauth_identities WHERE provider = 'wechat' AND openid = ?").get('wechat-openid')
  assert.ok(identity)
  assert.equal(identity.unionid, 'wechat-unionid')

  const poll = await fetch(`${app.baseUrl}/api/auth/wechat/poll`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: challenge.ticket, pollSecret: challenge.pollSecret }),
  })
  assert.equal(poll.status, 200)
  const result = await poll.json()
  assert.equal(result.status, 'authenticated')
  assert.equal(result.user.id, identity.user_id)
  assert.equal(result.user.nickname, '微信用户')
  assert.ok(poll.headers.get('set-cookie')?.includes('chat_demo_session='))

  const me = await fetch(`${app.baseUrl}/api/auth/me`, {
    headers: { cookie: poll.headers.get('set-cookie').split(';')[0] },
  })
  assert.equal((await me.json()).user.id, identity.user_id)

  const replay = await fetch(`${app.baseUrl}/api/auth/wechat/callback?code=single-use-code&state=${state}`)
  assert.equal(replay.status, 400)

  const replayPoll = await fetch(`${app.baseUrl}/api/auth/wechat/poll`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: challenge.ticket, pollSecret: challenge.pollSecret }),
  })
  assert.equal(replayPoll.status, 404)
})

test('the same WeChat login can opt in to display profile without changing the account', async (t) => {
  const origin = 'http://localhost:8090'
  let profileRequests = 0
  const app = await makeServer({
    wechatAppId: 'wx-test-app',
    wechatAppSecret: 'test-secret',
    wechatRedirectUri: origin + '/api/auth/wechat/callback',
    fetchImpl: async (url) => {
      if (url.pathname === '/sns/oauth2/access_token') {
        return Response.json({
          access_token: 'web-token',
          openid: 'my-openid',
          scope: url.searchParams.get('code') === 'base-scope' ? 'snsapi_base' : 'snsapi_userinfo',
        })
      }
      profileRequests += 1
      assert.equal(url.pathname, '/sns/userinfo')
      assert.equal(url.searchParams.get('openid'), 'my-openid')
      return Response.json({
        openid: 'my-openid',
        nickname: '新昵称',
        headimgurl: 'http://thirdwx.qlogo.cn/mmopen/example/132',
      })
    },
  })
  t.after(app.close)
  app.db.prepare(`INSERT INTO oauth_identities (id, user_id, provider, openid, created_at, updated_at)
    VALUES (?, ?, 'wechat', 'my-openid', ?, ?)`).run(randomUUID(), app.userId, Date.now(), Date.now())

  const headers = { origin, 'content-type': 'application/json' }
  const start = async (includeProfile) => {
    const response = await fetch(app.baseUrl + '/api/auth/wechat/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ includeProfile }),
    })
    assert.equal(response.status, 200)
    const { ticket, pollSecret, authorizeUrl } = await response.json()
    const authorize = new URL(authorizeUrl)
    assert.equal(authorize.searchParams.get('scope'), includeProfile ? 'snsapi_userinfo' : 'snsapi_base')
    const state = authorize.searchParams.get('state')
    return {
      callback: (code) => fetch(app.baseUrl + '/api/auth/wechat/callback?' + new URLSearchParams({ state, code })),
      poll: () => fetch(app.baseUrl + '/api/auth/wechat/poll', {
        method: 'POST', headers, body: JSON.stringify({ ticket, pollSecret }),
      }),
    }
  }

  for (const [code, status] of [['authdeny', 400], ['base-scope', 502]]) {
    const attempt = await start(true)
    assert.equal((await attempt.callback(code)).status, status)
    assert.equal((await attempt.poll()).status, 400)
  }
  assert.equal(profileRequests, 0)

  const basic = await start(false)
  // Even a token with profile scope does not trigger profile access for an opt-out login.
  assert.equal((await basic.callback('granted')).status, 200)
  assert.equal((await (await basic.poll()).json()).user.nickname, 'Test User')
  assert.equal(profileRequests, 0)

  const consent = await start(true)
  assert.equal((await consent.callback('granted')).status, 200)
  const response = await consent.poll()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie'), /chat_demo_session=/)
  const expectedUser = {
    id: app.userId,
    nickname: '新昵称',
    avatarUrl: 'https://thirdwx.qlogo.cn/mmopen/example/132',
  }
  assert.deepEqual(await response.json(), { status: 'authenticated', user: expectedUser })
  assert.equal(profileRequests, 1)
  assert.equal((await consent.poll()).status, 404)

  const next = await start(false)
  assert.equal((await next.callback('base-scope')).status, 200)
  assert.deepEqual((await (await next.poll()).json()).user, expectedUser)
  assert.equal(profileRequests, 1)
})

test('database upgrade preserves basic login attempts and retires separate profile QR codes', (t) => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  db.exec(`
    ALTER TABLE wechat_login_attempts DROP COLUMN include_profile;
    CREATE TABLE wechat_profile_attempts (
      ticket_hash TEXT PRIMARY KEY REFERENCES wechat_login_attempts(ticket_hash) ON DELETE CASCADE
    );
    INSERT INTO wechat_login_attempts (ticket_hash, poll_secret_hash, state_hash, expires_at, created_at)
      VALUES ('basic', 'poll-a', 'state-a', 2, 1), ('separate', 'poll-b', 'state-b', 2, 1);
    INSERT INTO wechat_profile_attempts (ticket_hash) VALUES ('separate');
  `)

  migrateDatabase(db)
  const attempts = db.prepare('SELECT ticket_hash, include_profile FROM wechat_login_attempts').all()
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].ticket_hash, 'basic')
  assert.equal(attempts[0].include_profile, 0)
  assert.equal(db.prepare('SELECT count(*) AS count FROM wechat_profile_attempts').get().count, 0)
})
