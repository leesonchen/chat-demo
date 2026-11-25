import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { createDatabase } from '../database.mjs'
import { createAppServer } from '../app.mjs'
import { sha256 } from '../security.mjs'
import { openMembershipOrder, settleMembershipOrder } from '../membership.mjs'
import { createWechatNative } from '../wechat-pay.mjs'

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
      wechatMobileAuth: options.wechatMobileAuth,
      wechatPay: options.wechatPay,
      membershipMode: options.membershipMode,
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

  const inline = await fetch(`${app.baseUrl}/api/backup?inline=1`, { headers: { cookie } })
  assert.equal(inline.status, 200)
  assert.equal(inline.headers.get('content-disposition'), null)
  assert.match(download.headers.get('content-disposition'), /^attachment;/)
  assert.equal(inline.headers.get('x-backup-sha256'), sha256(archive))
  assert.deepEqual(Buffer.from(await inline.arrayBuffer()), archive)

  const missingForOtherUser = await fetch(`${app.baseUrl}/api/backup/status`)
  assert.equal(missingForOtherUser.status, 401)
})

test('only active members can backup and restore when membership is required', async t => {
  let time = Date.now()
  const app = await makeServer({ membershipMode: 'required', now: () => time })
  t.after(app.close)
  const cookie = 'chat_demo_session=' + app.token
  const origin = 'http://localhost:8090'
  app.db.prepare('UPDATE sessions SET expires_at = ?').run(time + 90 * 24 * 60 * 60 * 1000)
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02])

  const get = (path) => fetch(app.baseUrl + path, { headers: { Cookie: cookie } })
  const upload = () => fetch(app.baseUrl + '/api/backup', {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/zip' },
    body: zip,
  })
  const free = await (await get('/api/membership')).json()
  assert.equal(free.tier, 'free')
  assert.equal(free.plan.amountFen, 100)
  assert.equal(free.cloudBackupAllowed, false)
  const denied = await upload()
  assert.equal(denied.status, 402)
  assert.equal((await denied.json()).error.code, 'membership_required')
  assert.equal((await get('/api/backup')).status, 402)

  const orderId = openMembershipOrder(app.db, app.userId, 'wechat', time)
  assert.equal((await (await get('/api/membership')).json()).tier, 'free')
  const paidUntil = settleMembershipOrder(app.db, {
    orderId, provider: 'wechat', transactionId: 'wechat-order-1', amountFen: 100, currency: 'CNY',
  }, time)
  assert.equal((await (await get('/api/membership')).json()).tier, 'member')
  const trialWhilePaid = await fetch(app.baseUrl + '/api/membership/trial', {
    method: 'POST', headers: { Origin: origin, Cookie: cookie },
  })
  assert.equal(trialWhilePaid.status, 200)
  assert.equal((await trialWhilePaid.json()).validUntil, new Date(paidUntil).toISOString())
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM membership_trials').get().n, 0)
  assert.equal((await upload()).status, 200)
  assert.deepEqual(Buffer.from(await (await get('/api/backup')).arrayBuffer()), zip)

  time = paidUntil
  const status = await (await get('/api/backup/status')).json()
  assert.equal(status.exists, true)
  assert.equal(status.membership.tier, 'free')
  assert.equal((await upload()).status, 402)
  assert.equal((await get('/api/backup')).status, 402)
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM user_backups').get().n, 1)
})

test('preview presents the plan while allowing existing cloud backups', async t => {
  const app = await makeServer({ membershipMode: 'preview' })
  t.after(app.close)
  const response = await fetch(app.baseUrl + '/api/backup/status', {
    headers: { Cookie: 'chat_demo_session=' + app.token },
  })
  const { membership } = await response.json()
  assert.equal(membership.mode, 'preview')
  assert.equal(membership.tier, 'free')
  assert.equal(membership.cloudBackupAllowed, true)
})

test('free trial grants a calendar month of backup and restore access without a payment order', async t => {
  const january = Date.parse('2026-01-31T02:00:00Z')
  const february = Date.parse('2026-02-28T02:00:00Z')
  let time = january
  const app = await makeServer({ membershipMode: 'required', now: () => time })
  t.after(app.close)
  const cookie = `chat_demo_session=${app.token}`
  const origin = 'http://localhost:8090'
  const trial = headers => fetch(`${app.baseUrl}/api/membership/trial`, { method: 'POST', headers })
  const backup = `${app.baseUrl}/api/backup`
  const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const upload = () => fetch(backup, {
    method: 'PUT', headers: { origin, cookie, 'Content-Type': 'application/zip' }, body: archive,
  })

  assert.equal((await trial({ origin })).status, 401)
  assert.equal((await trial({ origin: 'https://other.example.com', cookie })).status, 403)
  assert.equal((await upload()).status, 402)

  const response = await trial({ origin, cookie })
  assert.equal(response.status, 200)
  const membership = await response.json()
  assert.equal(membership.tier, 'member')
  assert.equal(membership.validUntil, new Date(february).toISOString())
  assert.equal(membership.paidUntil, null)
  assert.equal(membership.cloudBackupAllowed, true)
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM membership_orders').get().n, 0)
  assert.deepEqual(await (await trial({ origin, cookie })).json(), membership)
  time += 7 * 24 * 60 * 60 * 1000
  assert.deepEqual(await (await trial({ origin, cookie })).json(), membership)
  assert.equal((await upload()).status, 200)
  const download = await fetch(backup, { headers: { cookie } })
  assert.equal(download.status, 200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), archive)

  time = february
  const { exists, membership: expired } = await (await fetch(`${backup}/status`, { headers: { cookie } })).json()
  assert.equal(exists, true)
  assert.equal(expired.tier, 'free')
  assert.equal((await fetch(backup, { headers: { cookie } })).status, 402)
  const renewed = await trial({ origin, cookie })
  assert.equal(renewed.status, 200)
  assert.equal((await renewed.json()).validUntil, '2026-03-28T02:00:00.000Z')
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

test('WeChat browser selects webpage authorization and cancellation consumes only its own state', async t => {
  const app = await makeServer({ wechatAuth, fetchImpl: async () => assert.fail('A cancellation must not exchange a code') })
  t.after(app.close)
  const ordinary = await startLogin(app)
  assert.equal(new URL((await ordinary.json()).authorizeUrl).searchParams.get('mode'), null)
  const start = await fetch(app.baseUrl + '/api/auth/wechat/start', {
    method: 'POST', headers: { Origin: appOrigin, 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0' },
  })
  const params = new URL((await start.json()).authorizeUrl).searchParams
  assert.equal(params.get('mode'), 'wechat_browser')
  const url = app.baseUrl + callbackPath + '?' + new URLSearchParams({ state: params.get('state'), error: 'access_denied' })
  const cookie = cookiePair(start.headers.get('set-cookie'))
  assert.equal((await fetch(url, { redirect: 'manual' })).headers.get('location'), '/?wechat_login=failed')
  const cancelled = await fetch(url, { redirect: 'manual', headers: { Cookie: cookie } })
  assert.equal(cancelled.headers.get('location'), '/?wechat_login=cancelled')
  assert.match(cancelled.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await fetch(url, { redirect: 'manual', headers: { Cookie: cookie } })).headers.get('location'), '/?wechat_login=failed')
})

test('WeChat browser profile sync updates only the current authorized account and keeps its session', async t => {
  let identity = { appid: wechatAuth.wechatAppId, openid: 'different-wechat' }
  let exchanges = 0
  const app = await makeServer({
    wechatAuth,
    fetchImpl: async () => {
      exchanges++
      return Response.json(identity)
    },
  })
  t.after(app.close)
  const timestamp = Date.now()
  app.db.prepare(`INSERT INTO oauth_identities (id, user_id, provider, openid, created_at, updated_at)
    VALUES (?, ?, 'wechat', 'existing-openid', ?, ?)`).run(randomUUID(), app.userId, timestamp, timestamp)
  const signedIn = 'chat_demo_session=' + app.token
  const start = (profile, cookie) => fetch(app.baseUrl + '/api/auth/wechat/start?profile=' + profile, {
    method: 'POST',
    headers: { Origin: appOrigin, 'User-Agent': 'MicroMessenger', ...(cookie && { Cookie: cookie }) },
  })
  const authorizeWithProfile = await start('1')
  assert.equal(new URL((await authorizeWithProfile.json()).authorizeUrl).searchParams.get('include_profile'), '1')
  assert.equal((await start('sync')).status, 401)
  const callback = async ({ session = signedIn } = {}) => {
    const response = await start('sync', signedIn)
    assert.equal(response.status, 200)
    const params = new URL((await response.json()).authorizeUrl).searchParams
    assert.equal(params.get('include_profile'), '1')
    assert.match(params.get('state'), /^profile_/)
    const query = new URLSearchParams({ state: params.get('state'), code: 'C'.repeat(43) })
    const cookie = [cookiePair(response.headers.get('set-cookie')), session].filter(Boolean).join('; ')
    return fetch(app.baseUrl + callbackPath + '?' + query, { redirect: 'manual', headers: { Cookie: cookie } })
  }
  const getMe = async () => (await fetch(app.baseUrl + '/api/auth/me', { headers: { Cookie: signedIn } })).json()

  assert.equal((await callback({ session: '' })).headers.get('location'), '/?wechat_login=profile_failed')
  assert.equal(exchanges, 0)
  assert.equal((await callback()).headers.get('location'), '/?wechat_login=profile_mismatch')
  assert.equal((await getMe()).user.nickname, 'Test User')
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 1)

  identity = { ...identity, openid: 'existing-openid' }
  assert.equal((await callback()).headers.get('location'), '/?wechat_login=profile_unavailable')
  identity = { ...identity, profile: { nickname: '微信显示名', avatarUrl: 'https://thirdwx.qlogo.cn/avatar/132' } }
  const synced = await callback()
  assert.equal(synced.headers.get('location'), '/?wechat_login=profile_ok')
  assert.equal(synced.headers.getSetCookie().length, 1)
  assert.match(synced.headers.getSetCookie()[0], /^chat_demo_wechat_login=;/)
  assert.deepEqual((await getMe()).user, { id: app.userId, ...identity.profile })
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM sessions').get().count, 1)
})

test('delegated login restores the existing account and applies only authorized profile details', async (t) => {
  let authorize
  let exchanged = 0
  let profile
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
      return Response.json({ appid: wechatAuth.wechatAppId, openid: 'existing-openid', profile })
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

  profile = { nickname: '更新后的昵称', avatarUrl: 'https://other.example.com/image.png' }
  const nextStart = await startLogin(app)
  authorize = new URL((await nextStart.json()).authorizeUrl)
  const next = await callback(cookiePair(nextStart.headers.get('set-cookie')), authorize.searchParams.get('state'))
  assert.equal(next.headers.get('location'), '/?wechat_login=ok')
  const nextSession = cookiePair(next.headers.getSetCookie()[0])
  const updated = await fetch(app.baseUrl + '/api/auth/me', { headers: { Cookie: nextSession } })
  assert.deepEqual(await updated.json(), {
    user: { id: app.userId, nickname: profile.nickname, avatarUrl: avatar },
  })
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 1)
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

const wechatMobileAuth = {
  appId: 'wxabcdef0123456789',
  appSecret: 'f'.repeat(32),
}
const mobilePost = (app, action, body, cookie, origin = appOrigin) => fetch(
  app.baseUrl + '/api/auth/wechat/mobile/' + action,
  {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify(body),
  },
)
const beginMobileLogin = async (app, session) => {
  const response = await mobilePost(app, 'start', { link: Boolean(session) }, session)
  assert.equal(response.status, 200)
  const { state, appId } = await response.json()
  assert.equal(appId, wechatMobileAuth.appId)
  const browser = cookiePair(response.headers.get('set-cookie'))
  const cookie = session ? browser + '; ' + session : browser
  return { state, cookie }
}
const getSignedInUser = async (app, response) => {
  const [session] = response.headers.getSetCookie()
  assert.match(session, /^chat_demo_session=/)
  const me = await fetch(app.baseUrl + '/api/auth/me', { headers: { Cookie: cookiePair(session) } })
  return (await me.json()).user
}
const mobileWechat = async (url, options) => {
  assert.equal(url.origin, 'https://api.weixin.qq.com')
  assert.equal(options.redirect, 'error')
  if (url.pathname === '/sns/oauth2/access_token') {
    assert.equal(url.searchParams.get('appid'), wechatMobileAuth.appId)
    assert.equal(url.searchParams.get('secret'), wechatMobileAuth.appSecret)
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code')
    assert.equal(url.searchParams.get('code'), 'wechat-code')
    return Response.json({ openid: 'mobile-openid', unionid: 'shared-unionid', access_token: 'wechat-token' })
  }
  assert.equal(url.pathname, '/sns/userinfo')
  assert.equal(url.searchParams.get('openid'), 'mobile-openid')
  return Response.json({ openid: 'mobile-openid', nickname: 'App user', headimgurl: 'https://wx.qlogo.cn/avatar/132' })
}

test('mobile authorization requires the matching browser and explicitly confirmed account creation', async t => {
  let exchanges = 0
  const app = await makeServer({
    wechatMobileAuth,
    fetchImpl: (url, options) => {
      if (url.pathname === '/sns/oauth2/access_token') exchanges++
      return mobileWechat(url, options)
    },
  })
  t.after(app.close)
  const me = await fetch(app.baseUrl + '/api/auth/me?client=android')
  assert.deepEqual(await me.json(), { user: null, wechatAppLoginAvailable: true })
  assert.equal((await mobilePost(app, 'start', {}, null, 'https://other.example.com')).status, 403)
  assert.equal((await mobilePost(app, 'start', { link: true })).status, 401)
  const { state, cookie } = await beginMobileLogin(app)
  const auth = { state, code: 'wechat-code' }
  assert.equal((await mobilePost(app, 'create', { state }, cookie)).status, 400)
  assert.equal((await mobilePost(app, 'finish', auth)).status, 400)
  assert.equal(exchanges, 0)

  const finish = await mobilePost(app, 'finish', auth, cookie)
  assert.deepEqual(await finish.json(), { needsAccount: true })
  assert.deepEqual(finish.headers.getSetCookie(), [])
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 1)
  assert.equal((await mobilePost(app, 'finish', auth, cookie)).status, 400)

  const created = await mobilePost(app, 'create', { state }, cookie)
  assert.equal(created.status, 200)
  const user = await getSignedInUser(app, created)
  assert.notEqual(user.id, app.userId)
  assert.equal(user.nickname, 'App user')
  assert.equal(user.avatarUrl, 'https://wx.qlogo.cn/avatar/132')
  assert.equal(exchanges, 1)
  assert.equal((await mobilePost(app, 'create', { state }, cookie)).status, 400)

  const next = await beginMobileLogin(app)
  const signedIn = await mobilePost(app, 'finish', { state: next.state, code: 'wechat-code' }, next.cookie)
  assert.equal((await getSignedInUser(app, signedIn)).id, user.id)
})

test('mobile authorization restores by verified UnionID or by explicit linking from a signed-in legacy account', async t => {
  for (const existingUnionId of ['shared-unionid', null, 'different-wechat']) {
    const app = await makeServer({ wechatAuth, wechatMobileAuth, fetchImpl: mobileWechat })
    t.after(app.close)
    const time = Date.now()
    app.db.prepare(`INSERT INTO oauth_identities (id, user_id, provider, openid, unionid, created_at, updated_at)
      VALUES (?, ?, 'wechat', 'official-openid', ?, ?, ?)`).run(randomUUID(), app.userId, existingUnionId, time, time)
    const session = 'chat_demo_session=' + app.token
    const finishLogin = ({ state, cookie }) => mobilePost(app, 'finish', { state, code: 'wechat-code' }, cookie)
    if (existingUnionId !== 'shared-unionid') {
      const unlinked = await finishLogin(await beginMobileLogin(app))
      assert.deepEqual(await unlinked.json(), { needsAccount: true })
      const expiredSession = await beginMobileLogin(app, session)
      assert.equal((await finishLogin({ ...expiredSession, cookie: expiredSession.cookie.split(';')[0] })).status, 401)
      const linked = await finishLogin(await beginMobileLogin(app, session))
      if (existingUnionId === 'different-wechat') {
        assert.equal(linked.status, 409)
        assert.equal(app.db.prepare('SELECT count(*) AS count FROM oauth_identities').get().count, 1)
        continue
      }
      assert.equal((await getSignedInUser(app, linked)).id, app.userId)
    }
    const restored = await finishLogin(await beginMobileLogin(app))
    assert.equal((await getSignedInUser(app, restored)).id, app.userId)
    assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 1)
  }
})

test('WeChat purchases are paused and previously placed orders still settle once', async (t) => {
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const platform = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wechatPay = {
    appId: 'wx0123456789abcdef',
    mchId: '1234567890',
    merchantSerial: 'A1',
    merchantKey: merchant.privateKey,
    platformKeyId: 'PUB_KEY_ID_1234567890',
    platformKey: platform.publicKey,
    apiKey: randomBytes(16).toString('hex'),
  }
  const time = Date.now()
  const responseHeaders = body => {
    const timestamp = Math.floor(time / 1000)
    const nonce = 'platform-nonce'
    const signature = sign('sha256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), platform.privateKey)
    return {
      'wechatpay-timestamp': String(timestamp),
      'wechatpay-nonce': nonce,
      'wechatpay-serial': wechatPay.platformKeyId,
      'wechatpay-signature': signature.toString('base64'),
    }
  }
  let queriedTransaction
  let placements = 0
  const fetchImpl = async (address, options) => {
    const url = new URL(address)
    assert.equal(url.origin, 'https://api.mch.weixin.qq.com')
    const fields = Object.fromEntries(
      [...options.headers.Authorization.matchAll(/([a-z_]+)="([^"]+)"/g)].map(([, key, val]) => [key, val]),
    )
    assert.equal(fields.mchid, wechatPay.mchId)
    assert.equal(fields.serial_no, wechatPay.merchantSerial)
    const message = `${options.method}\n${url.pathname}${url.search}\n${fields.timestamp}\n${fields.nonce_str}\n${options.body ?? ''}\n`
    assert.ok(verify('sha256', Buffer.from(message), merchant.publicKey, Buffer.from(fields.signature, 'base64')))
    if (options.method === 'POST') {
      assert.equal(url.pathname, '/v3/pay/transactions/native')
      const body = JSON.parse(options.body)
      assert.equal(body.mchid, wechatPay.mchId)
      assert.equal(body.appid, wechatPay.appId)
      assert.match(body.out_trade_no, /^[a-f0-9]{32}$/)
      assert.equal(body.notify_url, 'http://localhost:8090/api/payments/wechat/native/notify')
      assert.deepEqual(body.amount, { total: 100, currency: 'CNY' })
      placements++
    } else {
      assert.equal(url.pathname, `/v3/pay/transactions/out-trade-no/${queriedTransaction.out_trade_no}`)
      assert.equal(url.searchParams.get('mchid'), wechatPay.mchId)
    }
    const body = JSON.stringify(options.method === 'POST'
      ? { code_url: 'weixin://wxpay/s/test' } : queriedTransaction)
    return new Response(body, { headers: responseHeaders(body) })
  }
  const app = await makeServer({ membershipMode: 'required', wechatPay, now: () => time, fetchImpl })
  t.after(app.close)
  const cookie = `chat_demo_session=${app.token}`
  const origin = 'http://localhost:8090'
  const startUrl = `${app.baseUrl}/api/membership/wechat/native`
  assert.equal((await fetch(startUrl, { method: 'POST', headers: { origin } })).status, 401)
  assert.equal((await fetch(startUrl, { method: 'POST', headers: { cookie } })).status, 403)
  assert.equal((await fetch(startUrl, { method: 'POST', headers: { origin, cookie } })).status, 503)
  assert.equal(placements, 0)
  const checkout = createWechatNative({ db: app.db, config: wechatPay, appOrigin: origin, fetchImpl, now: () => time })
  const start = () => checkout.start(app.userId)
  const [order, repeated] = await Promise.all([start(), start()])
  assert.equal(placements, 1)
  assert.deepEqual(order, repeated)
  assert.equal(order.status, 'pending')

  const membership = () => fetch(`${app.baseUrl}/api/membership`, { headers: { cookie } }).then(res => res.json())
  assert.equal((await membership()).cloudBackupAllowed, false)
  const receipt = {
    appid: wechatPay.appId,
    mchid: wechatPay.mchId,
    out_trade_no: order.id,
    transaction_id: '2026010100000001',
    trade_type: 'NATIVE',
    trade_state: 'SUCCESS',
    amount: { total: 100, currency: 'CNY' },
  }
  const notify = (transaction, validSignature = true) => {
    const nonce = randomBytes(6).toString('hex')
    const aad = 'transaction'
    const cipher = createCipheriv('aes-256-gcm', wechatPay.apiKey, nonce)
    cipher.setAAD(Buffer.from(aad))
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag(),
    ]).toString('base64')
    const body = JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource: {
      algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', associated_data: aad, nonce, ciphertext,
    } })
    return fetch(`${app.baseUrl}/api/payments/wechat/native/notify`, {
      method: 'POST',
      body,
      headers: responseHeaders(validSignature ? body : body + ' '),
    })
  }
  assert.equal((await notify(receipt, false)).status, 401)
  assert.equal((await notify({ ...receipt, amount: { total: 1, currency: 'CNY' } })).status, 400)
  assert.equal((await membership()).tier, 'free')
  assert.equal((await notify(receipt)).status, 204)
  const paidUntil = (await membership()).paidUntil
  assert.ok(paidUntil)
  assert.equal((await notify(receipt)).status, 204)
  assert.equal((await membership()).paidUntil, paidUntil)

  const nextOrder = await start()
  queriedTransaction = { ...receipt, out_trade_no: nextOrder.id, transaction_id: '2026010100000002' }
  const refreshed = await fetch(`${startUrl}/${nextOrder.id}`, { method: 'POST', headers: { cookie, origin } })
  assert.equal((await refreshed.json()).status, 'paid')
  assert.ok((await membership()).paidUntil > paidUntil)
})
