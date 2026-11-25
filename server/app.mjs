import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { grantMembershipTrial, membershipStatus } from './membership.mjs'
import { createWechatNative, WechatPayError, WECHAT_PAY_NOTIFY_PATH } from './wechat-pay.mjs'
import { decryptSecret, encryptSecret, sha256 } from './security.mjs'

const COOKIE = 'chat_demo_session'
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000
const LOGIN_COOKIE = 'chat_demo_wechat_login'
const WECHAT_CALLBACK_PATH = '/api/auth/wechat/callback'
const MOBILE_LOGIN_COOKIE = 'chat_demo_wechat_mobile'
const MOBILE_LOGIN_PATH = '/api/auth/wechat/mobile'
const LOGIN_TTL = 10 * 60 * 1000
const loginToken = () => randomBytes(32).toString('base64url')
const loginTokenPattern = /^[A-Za-z0-9_-]{43}$/
const MAX_JSON = 64 * 1024
const MAX_BACKUP = 200 * 1024 * 1024
const backupQueues = new Map()

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
  res.end(body)
}
const readCookie = (header = '', name) => header.split(';').map(part => part.trim())
  .find(part => part.startsWith(name + '='))?.slice(name.length + 1)
const setCookie = (token, secure) => `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`
const clearCookie = (secure) => `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
const readRequestBody = async (req) => {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > MAX_JSON) throw new HttpError(413, 'body_too_large'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
const readJson = async (req) => {
  const raw = await readRequestBody(req)
  try { const body = JSON.parse(raw.toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body }
  catch { throw new HttpError(400, 'invalid_json') }
}
const verifyOrigin = (req, config) => { if (req.headers.origin !== config.appOrigin) throw new HttpError(403, 'origin_not_allowed') }
const getSession = (req, db, now) => {
  const token = readCookie(req.headers.cookie, COOKIE)
  if (!token || token.length > 256) return null
  const tokenHash = sha256(token)
  const row = db.prepare(`SELECT s.token_hash, s.expires_at, u.id, u.nickname, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.status = 'active'`).get(tokenHash)
  if (!row) return null
  if (row.expires_at <= now) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); return null }
  return { tokenHash, user: { id: row.id, nickname: row.nickname, avatarUrl: row.avatar_url } }
}
const requireUser = (req, db, now) => { const session = getSession(req, db, now); if (!session) throw new HttpError(401, 'authentication_required'); return session }
const requireBackupMembership = (db, userId, time, mode) => {
  if (mode === 'required' && !membershipStatus(db, userId, time, mode).cloudBackupAllowed) {
    throw new HttpError(402, 'membership_required')
  }
}
const loginCookie = (token, secure, maxAge) =>
  `${LOGIN_COOKIE}=${token}; HttpOnly; Path=${WECHAT_CALLBACK_PATH}; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`

const beginWechatLogin = (req, res, url, config, db, time) => {
  if (!config.wechatAuth) throw new HttpError(503, 'wechat_login_not_configured')
  const wechatBrowser = /MicroMessenger/i.test(req.headers['user-agent'] ?? '')
  const profile = url.searchParams.get('profile')
  const syncProfile = profile === 'sync'
  if (syncProfile && !wechatBrowser) throw new HttpError(400, 'wechat_browser_required')
  const profileSessionHash = syncProfile ? requireUser(req, db, time).tokenHash : null
  const { origin, clientId } = config.wechatAuth
  const state = syncProfile ? `profile_${loginToken()}` : loginToken()
  const browserToken = loginToken()
  const verifier = loginToken()
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const redirectUri = new URL(WECHAT_CALLBACK_PATH, config.appOrigin).href

  db.prepare('DELETE FROM delegated_wechat_attempts WHERE expires_at <= ?').run(time)
  db.prepare(`
    INSERT INTO delegated_wechat_attempts (state_hash, browser_hash, verifier, profile_session_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(state), sha256(browserToken), verifier, profileSessionHash, time + LOGIN_TTL)

  const authorize = new URL('/authorize', origin)
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
  if (wechatBrowser) {
    authorize.searchParams.set('mode', 'wechat_browser')
    if (profile === '1' || syncProfile) authorize.searchParams.set('include_profile', '1')
  }
  return json(res, 200, { authorizeUrl: authorize.href }, {
    'Set-Cookie': loginCookie(browserToken, config.secureCookies, LOGIN_TTL / 1000),
  })
}

const readDisplayProfile = profile => {
  const nickname = typeof profile?.nickname === 'string'
    ? Array.from(profile.nickname.trim()).slice(0, 80).join('')
    : ''
  const avatar = typeof profile?.avatarUrl === 'string' && profile.avatarUrl.length <= 2048
    ? URL.parse(profile.avatarUrl)
    : null
  const avatarUrl = avatar?.protocol === 'https:' && !avatar.username && !avatar.password && !avatar.port &&
    ['thirdwx.qlogo.cn', 'wx.qlogo.cn'].includes(avatar.hostname) ? avatar.href : ''
  return { nickname, avatarUrl }
}

const updateWechatDisplayProfile = (db, userId, profile, time) => {
  db.prepare(`
    UPDATE users SET nickname = COALESCE(NULLIF(?, ''), nickname),
      avatar_url = COALESCE(NULLIF(?, ''), avatar_url), updated_at = ?
    WHERE id = ?
  `).run(profile.nickname, profile.avatarUrl, time, userId)
}

const wechatIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const readWechatId = value => typeof value === 'string' && wechatIdPattern.test(value) ? value : null
const mobileProvider = config => config.wechatMobileAuth && `wechat_mobile:${config.wechatMobileAuth.appId}`

const issueWechatSession = (db, {
  provider = 'wechat', otherProvider, openid, unionid, profile, linkUserId, allowCreate = true,
}, time) => {
  const sessionToken = loginToken()
  db.exec('BEGIN IMMEDIATE')
  try {
    const identity = db.prepare(`
      SELECT user_id, unionid FROM oauth_identities WHERE provider = ? AND openid = ?
    `).get(provider, openid)
    const unionMatches = unionid ? db.prepare(`
      SELECT DISTINCT user_id FROM oauth_identities WHERE provider IN (?, ?) AND unionid = ?
    `).all(provider, otherProvider ?? provider, unionid) : []
    const matchingUsers = new Set(unionMatches.map(row => row.user_id))
    if (identity) matchingUsers.add(identity.user_id)
    if (linkUserId) matchingUsers.add(linkUserId)
    if (matchingUsers.size > 1 || (identity?.unionid && unionid && identity.unionid !== unionid)) {
      throw new HttpError(409, 'wechat_account_conflict')
    }
    const [existingUserId] = matchingUsers
    if (!existingUserId && !allowCreate) {
      db.exec('COMMIT')
      return null
    }
    const userId = existingUserId ?? randomUUID()
    if (!existingUserId) {
      db.prepare('INSERT INTO users (id, nickname, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, profile.nickname || '微信用户', profile.avatarUrl, time, time)
    } else {
      if (db.prepare('SELECT status FROM users WHERE id = ?').get(userId)?.status !== 'active') {
        throw new HttpError(403, 'wechat_account_inactive')
      }
      const conflictingIdentity = db.prepare(`
        SELECT 1 FROM oauth_identities WHERE user_id = ? AND (
          (provider = ? AND openid <> ?) OR (provider = ? AND unionid IS NOT NULL AND unionid <> ?)
        )
      `).get(userId, provider, openid, otherProvider ?? provider, unionid ?? null)
      if (conflictingIdentity) throw new HttpError(409, 'wechat_account_conflict')
      updateWechatDisplayProfile(db, userId, profile, time)
    }
    if (identity) {
      db.prepare(`
        UPDATE oauth_identities SET unionid = COALESCE(unionid, ?), updated_at = ? WHERE provider = ? AND openid = ?
      `).run(unionid ?? null, time, provider, openid)
    } else {
      db.prepare(`
        INSERT INTO oauth_identities (id, user_id, provider, openid, unionid, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), userId, provider, openid, unionid ?? null, time, time)
    }
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(sessionToken), userId, time + SESSION_TTL, time)
    db.exec('COMMIT')
    return sessionToken
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const returnFromLogin = (res, status, cookies = []) => {
  res.writeHead(303, {
    Location: `/?wechat_login=${status}`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  })
  res.end()
}

const wechatCallback = async (req, res, url, { db, config, fetchImpl, now }) => {
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const error = url.searchParams.get('error')
  const rejected = !code && (error === 'access_denied' || error === 'temporarily_unavailable')
  const browserToken = readCookie(req.headers.cookie, LOGIN_COOKIE) ?? ''
  const validState = loginTokenPattern.test(state) || (state.startsWith('profile_') && loginTokenPattern.test(state.slice(8)))
  if (!config.wechatAuth || !validState || !loginTokenPattern.test(browserToken) ||
      (!rejected && !loginTokenPattern.test(code))) {
    return returnFromLogin(res, 'failed')
  }
  const attempt = db.prepare(`
    DELETE FROM delegated_wechat_attempts
    WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
    RETURNING verifier, profile_session_hash
  `).get(sha256(state), sha256(browserToken), now())
  if (!attempt) return returnFromLogin(res, 'failed')

  const { origin, clientId, clientSecret, wechatAppId } = config.wechatAuth
  const clearLogin = loginCookie('', config.secureCookies, 0)
  const failureStatus = attempt.profile_session_hash ? 'profile_failed' : 'failed'
  if (rejected) {
    return returnFromLogin(res, error === 'access_denied' ? 'cancelled' : failureStatus, [clearLogin])
  }
  if (attempt.profile_session_hash && getSession(req, db, now())?.tokenHash !== attempt.profile_session_hash) {
    return returnFromLogin(res, failureStatus, [clearLogin])
  }
  try {
    const authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const response = await fetchImpl(new URL('/exchange', origin), {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        redirect_uri: new URL(WECHAT_CALLBACK_PATH, config.appOrigin).href,
        code_verifier: attempt.verifier,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error('WeChat login code exchange failed')
    const identity = await response.json()
    if (identity?.appid !== wechatAppId || !readWechatId(identity.openid)) {
      throw new Error('Unexpected WeChat identity')
    }
    const profile = readDisplayProfile(identity.profile)
    if (attempt.profile_session_hash) {
      const session = getSession(req, db, now())
      if (session?.tokenHash !== attempt.profile_session_hash) {
        return returnFromLogin(res, failureStatus, [clearLogin])
      }
      const sameAccount = db.prepare(`
        SELECT 1 FROM oauth_identities WHERE provider = 'wechat' AND openid = ? AND user_id = ?
      `).get(identity.openid, session.user.id)
      if (!sameAccount) return returnFromLogin(res, 'profile_mismatch', [clearLogin])
      if (!profile.nickname && !profile.avatarUrl) return returnFromLogin(res, 'profile_unavailable', [clearLogin])
      updateWechatDisplayProfile(db, session.user.id, profile, now())
      return returnFromLogin(res, 'profile_ok', [clearLogin])
    }
    const sessionToken = issueWechatSession(db, {
      openid: identity.openid, unionid: readWechatId(identity.unionid),
      otherProvider: mobileProvider(config), profile,
    }, now())
    process.stdout.write('[chat-demo-server] delegated WeChat login succeeded\n')
    return returnFromLogin(res, 'ok', [setCookie(sessionToken, config.secureCookies), clearLogin])
  } catch {
    process.stderr.write('[chat-demo-server] delegated WeChat login failed\n')
    return returnFromLogin(res, failureStatus, [clearLogin])
  }
}

const mobileLoginCookie = (token, secure, maxAge) =>
  `${MOBILE_LOGIN_COOKIE}=${token}; HttpOnly; Path=${MOBILE_LOGIN_PATH}; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`

const beginMobileWechatLogin = async (req, res, { db, config, now }) => {
  const { link } = await readJson(req)
  const time = now()
  const linkUserId = link === true ? requireUser(req, db, time).user.id : null
  const state = loginToken()
  const browserToken = loginToken()
  db.prepare('DELETE FROM mobile_wechat_attempts WHERE expires_at <= ?').run(time)
  db.prepare(`
    INSERT INTO mobile_wechat_attempts (state_hash, browser_hash, link_user_id, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(sha256(state), sha256(browserToken), linkUserId, time + LOGIN_TTL)
  return json(res, 200, { appId: config.wechatMobileAuth.appId, state }, {
    'Set-Cookie': mobileLoginCookie(browserToken, config.secureCookies, LOGIN_TTL / 1000),
  })
}

const exchangeMobileWechatCode = async (code, { appId, appSecret }, fetchImpl) => {
  const fetchWechat = async (path, params, timeout) => {
    const url = new URL(path, 'https://api.weixin.qq.com')
    url.search = new URLSearchParams(params)
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error('WeChat API request failed')
    return response.json()
  }
  const token = await fetchWechat('/sns/oauth2/access_token', {
    appid: appId, secret: appSecret, code, grant_type: 'authorization_code',
  }, 6_000)
  const openid = readWechatId(token.openid)
  if (token.errcode || !openid || typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('WeChat did not return an identity')
  }
  let unionid = readWechatId(token.unionid)
  const profile = await fetchWechat('/sns/userinfo', {
    access_token: token.access_token, openid, lang: 'zh_CN',
  }, 3_000).catch(() => null)
  if (profile?.openid === openid && !profile.errcode) {
    unionid ??= readWechatId(profile.unionid)
    return { openid, unionid, profile: readDisplayProfile({ nickname: profile.nickname, avatarUrl: profile.headimgurl }) }
  }
  return { openid, unionid, profile: readDisplayProfile(null) }
}

const completeMobileWechatLogin = async (req, res, { db, config, fetchImpl, now }, createAccount) => {
  const { state, code } = await readJson(req)
  const browserToken = readCookie(req.headers.cookie, MOBILE_LOGIN_COOKIE) ?? ''
  if (typeof state !== 'string' || !loginTokenPattern.test(state) || !loginTokenPattern.test(browserToken) ||
      (!createAccount && (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(code)))) {
    throw new HttpError(400, 'invalid_wechat_login')
  }
  const stateHash = sha256(state), browserHash = sha256(browserToken)
  const attempt = db.prepare(`
    DELETE FROM mobile_wechat_attempts
    WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? AND (pending_identity IS NOT NULL) = ?
    RETURNING link_user_id, pending_identity, expires_at
  `).get(stateHash, browserHash, now(), Number(createAccount))
  if (!attempt) throw new HttpError(400, 'invalid_wechat_login')
  const verifyLinkSession = () => {
    if (attempt.link_user_id && requireUser(req, db, now()).user.id !== attempt.link_user_id) {
      throw new HttpError(403, 'wechat_account_conflict')
    }
  }
  verifyLinkSession()

  let identity
  try {
    identity = createAccount ? JSON.parse(attempt.pending_identity)
      : await exchangeMobileWechatCode(code, config.wechatMobileAuth, fetchImpl)
  } catch {
    throw new HttpError(502, 'wechat_login_failed')
  }
  if (attempt.expires_at <= now()) throw new HttpError(400, 'invalid_wechat_login')
  verifyLinkSession()
  if (attempt.link_user_id && !identity.unionid) throw new HttpError(502, 'wechat_login_failed')
  const sessionToken = issueWechatSession(db, {
    ...identity, provider: mobileProvider(config), otherProvider: config.wechatAuth ? 'wechat' : undefined,
    linkUserId: attempt.link_user_id, allowCreate: createAccount,
  }, now())
  if (!sessionToken) {
    db.prepare(`
      INSERT INTO mobile_wechat_attempts (state_hash, browser_hash, pending_identity, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(stateHash, browserHash, JSON.stringify(identity), attempt.expires_at)
    return json(res, 200, { needsAccount: true })
  }
  return json(res, 200, { needsAccount: false }, {
    'Set-Cookie': [setCookie(sessionToken, config.secureCookies), mobileLoginCookie('', config.secureCookies, 0)],
  })
}

const writeBackup = async (req, directory, userId) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const fileName = `${userId}.${randomUUID()}.zip`, destination = path.join(directory, fileName), temporary = `${destination}.tmp`
  const digest = createHash('sha256'); let size = 0; let prefix = Buffer.alloc(0)
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length
    if (size > MAX_BACKUP) return callback(new HttpError(413, 'backup_too_large'))
    if (prefix.length < 4) prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.length)])
    digest.update(chunk); callback(null, chunk)
  } })
  try {
    await pipeline(req, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    if (prefix.length < 4 || prefix[0] !== 0x50 || prefix[1] !== 0x4b || prefix[2] !== 0x03 || prefix[3] !== 0x04) throw new HttpError(400, 'invalid_backup_archive')
    await rename(temporary, destination)
    return { fileName, byteSize: size, digest: digest.digest('hex'), destination }
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); await rm(destination, { force: true }).catch(() => {}); throw error }
}
const serializeBackup = (userId, task) => {
  const previous = backupQueues.get(userId) ?? Promise.resolve()
  const next = previous.then(task, task)
  const tail = next.catch(() => {})
  backupQueues.set(userId, tail)
  return next.finally(() => { if (backupQueues.get(userId) === tail) backupQueues.delete(userId) })
}

export const createAppServer = ({ db, config, fetchImpl = fetch, now = Date.now }) => {
  if (!db || !config?.appOrigin || !config?.backupDir || !config?.encryptionKey) throw new Error('Database, appOrigin, backupDir, and encryptionKey are required')
  const mode = config.membershipMode ?? 'off'
  const wechatNative = config.wechatPay
    ? createWechatNative({ db, config: config.wechatPay, appOrigin: config.appOrigin, fetchImpl, now })
    : null
  const getMembership = (userId, time) => ({
    ...membershipStatus(db, userId, time, mode),
    wechatNativeAvailable: false,
  })
  return http.createServer(async (req, res) => {
    const time = now()
    try {
      const url = new URL(req.url ?? '/', config.appOrigin), method = req.method ?? 'GET'
      if (method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true })
      if (method === 'POST' && url.pathname === '/api/auth/wechat/start') {
        verifyOrigin(req, config)
        return beginWechatLogin(req, res, url, config, db, time)
      }
      if (method === 'GET' && url.pathname === WECHAT_CALLBACK_PATH) {
        return await wechatCallback(req, res, url, { db, config, fetchImpl, now })
      }
      if (method === 'POST' && url.pathname.startsWith(MOBILE_LOGIN_PATH + '/')) {
        verifyOrigin(req, config)
        if (!config.wechatMobileAuth) throw new HttpError(503, 'wechat_mobile_not_configured')
        const context = { db, config, fetchImpl, now }
        if (url.pathname === MOBILE_LOGIN_PATH + '/start') return await beginMobileWechatLogin(req, res, context)
        if (url.pathname === MOBILE_LOGIN_PATH + '/finish' || url.pathname === MOBILE_LOGIN_PATH + '/create') {
          return await completeMobileWechatLogin(req, res, context, url.pathname.endsWith('/create'))
        }
      }
      if (method === 'GET' && url.pathname === '/api/auth/me') {
        const session = getSession(req, db, time)
        return json(res, 200, {
          user: session?.user ?? null,
          ...(url.searchParams.get('client') === 'android' && { wechatAppLoginAvailable: Boolean(config.wechatMobileAuth) }),
        })
      }
      if (method === 'POST' && url.pathname === '/api/auth/logout') {
        verifyOrigin(req, config); const session = getSession(req, db, time)
        if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash)
        res.writeHead(204, { 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie(config.secureCookies) }); return res.end()
      }
      if (url.pathname === '/api/account/api-key' && method === 'GET') {
        const { user } = requireUser(req, db, time)
        const secret = db.prepare('SELECT ciphertext, iv, auth_tag FROM user_secrets WHERE user_id = ?').get(user.id)
        return json(res, 200, { apiKey: secret ? decryptSecret({ ciphertext: secret.ciphertext, iv: secret.iv, tag: secret.auth_tag }, config.encryptionKey, user.id) : null })
      }
      if (url.pathname === '/api/account/api-key' && method === 'PUT') {
        verifyOrigin(req, config); const { user } = requireUser(req, db, time); const body = await readJson(req)
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey || apiKey.length > 2048) throw new HttpError(400, 'invalid_api_key')
        const secret = encryptSecret(apiKey, config.encryptionKey, user.id)
        db.prepare(`INSERT INTO user_secrets (user_id, ciphertext, iv, auth_tag, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = excluded.updated_at`).run(user.id, secret.ciphertext, secret.iv, secret.tag, time)
        return json(res, 200, { saved: true })
      }
      if (url.pathname === '/api/account/api-key' && method === 'DELETE') {
        verifyOrigin(req, config); const { user } = requireUser(req, db, time)
        db.prepare('DELETE FROM user_secrets WHERE user_id = ?').run(user.id)
        return json(res, 200, { deleted: true })
      }
      if (method === 'POST' && url.pathname === WECHAT_PAY_NOTIFY_PATH) {
        if (!wechatNative) throw new HttpError(404, 'not_found')
        wechatNative.notify(new Headers(req.headers), await readRequestBody(req))
        res.writeHead(204)
        return res.end()
      }
      if (method === 'POST' && url.pathname === '/api/membership/wechat/native') {
        verifyOrigin(req, config)
        requireUser(req, db, time)
        throw new HttpError(503, 'wechat_payment_unavailable')
      }
      const orderId = /^\/api\/membership\/wechat\/native\/([a-f0-9]{32})$/.exec(url.pathname)?.[1]
      if (orderId && (method === 'GET' || method === 'POST')) {
        if (method === 'POST') verifyOrigin(req, config)
        const { user } = requireUser(req, db, time)
        if (!wechatNative) throw new HttpError(503, 'wechat_payment_unavailable')
        const order = method === 'GET' ? wechatNative.status(user.id, orderId)
          : await wechatNative.refresh(user.id, orderId)
        return json(res, 200, order)
      }
      if (method === 'GET' && url.pathname === '/api/membership') {
        const { user } = requireUser(req, db, time)
        return json(res, 200, getMembership(user.id, time))
      }
      if (method === 'POST' && url.pathname === '/api/membership/trial') {
        verifyOrigin(req, config)
        const { user } = requireUser(req, db, time)
        grantMembershipTrial(db, user.id, time)
        return json(res, 200, getMembership(user.id, time))
      }
      if (method === 'GET' && url.pathname === '/api/backup/status') {
        const { user } = requireUser(req, db, time), backup = db.prepare('SELECT byte_size, updated_at FROM user_backups WHERE user_id = ?').get(user.id)
        return json(res, 200, {
          exists: Boolean(backup),
          byteSize: backup?.byte_size ?? 0,
          updatedAt: backup ? new Date(backup.updated_at).toISOString() : null,
          membership: getMembership(user.id, time),
        })
      }
      if (method === 'PUT' && url.pathname === '/api/backup') {
        verifyOrigin(req, config); const { user } = requireUser(req, db, time)
        requireBackupMembership(db, user.id, time, mode)
        const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (!['application/zip', 'application/x-zip-compressed'].includes(contentType)) throw new HttpError(415, 'unsupported_backup_type')
        if (Number(req.headers['content-length'] ?? 0) > MAX_BACKUP) throw new HttpError(413, 'backup_too_large')
        const saved = await writeBackup(req, config.backupDir, user.id)
        try {
          await serializeBackup(user.id, async () => {
            requireBackupMembership(db, user.id, now(), mode)
            const previous = db.prepare('SELECT file_name FROM user_backups WHERE user_id = ?').get(user.id)
            try {
              db.prepare(`INSERT INTO user_backups (user_id, file_name, byte_size, sha256, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET file_name = excluded.file_name, byte_size = excluded.byte_size, sha256 = excluded.sha256, updated_at = excluded.updated_at`).run(user.id, saved.fileName, saved.byteSize, saved.digest, now())
            } catch (error) { throw error }
            if (previous?.file_name) await rm(path.join(config.backupDir, previous.file_name), { force: true }).catch(() => {})
          })
        } catch (error) {
          await rm(saved.destination, { force: true }).catch(() => {})
          throw error
        }
        return json(res, 200, { saved: true, byteSize: saved.byteSize, updatedAt: new Date(now()).toISOString() })
      }
      if (method === 'GET' && url.pathname === '/api/backup') {
        const { user } = requireUser(req, db, time)
        requireBackupMembership(db, user.id, time, mode)
        const backup = db.prepare('SELECT file_name, sha256 FROM user_backups WHERE user_id = ?').get(user.id)
        if (!backup) throw new HttpError(404, 'backup_not_found')
        const filePath = path.join(config.backupDir, backup.file_name)
        let info
        try { info = await stat(filePath) } catch { throw new HttpError(404, 'backup_not_found') }
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': info.size,
          ...(url.searchParams.get('inline') !== '1' && { 'Content-Disposition': 'attachment; filename="chat-demo-backup.zip"' }),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Backup-SHA256': backup.sha256,
        })
        await pipeline(createReadStream(filePath), res); return
      }
      throw new HttpError(404, 'not_found')
    } catch (error) {
      if (res.headersSent) return res.destroy()
      const knownError = error instanceof HttpError || error instanceof WechatPayError
      const status = knownError ? error.status : 500
      const code = knownError ? error.code : 'internal_error'
      json(res, status, { error: { code } })
      if (!knownError) process.stderr.write(`[chat-demo-server] ${code}\n`)
    }
  })
}
