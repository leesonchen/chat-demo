import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { decryptSecret, encryptSecret, sha256 } from './security.mjs'

const COOKIE = 'chat_demo_session'
const OAUTH_STATE_COOKIE = 'chat_demo_oauth_state'
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000
const STATE_TTL = 10 * 60 * 1000
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
const html = (res, status, origin, success, headers = {}) => {
  const message = success ? 'Login completed. You can close this window.' : 'WeChat login failed. Please close this window and try again.'
  const type = success ? 'chat-demo-auth-complete' : 'chat-demo-auth-failed'
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat Demo Login</title></head><body><p>${message}</p><script>if(window.opener)window.opener.postMessage({type:${JSON.stringify(type)}},${JSON.stringify(origin)});window.close();</script></body></html>`
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", ...headers })
  res.end(body)
}
const cookies = (header = '') => Object.fromEntries(header.split(';').map((x) => x.trim()).filter(Boolean).map((x) => {
  const i = x.indexOf('=')
  return i < 0 ? [x, ''] : [x.slice(0, i), decodeURIComponent(x.slice(i + 1))]
}))
const setCookie = (token, secure) => `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`
const clearCookie = (secure) => `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
const oauthStateCookie = (state, secure) => `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; HttpOnly; Path=/api/auth/wechat/callback; SameSite=Lax; Max-Age=${STATE_TTL / 1000}${secure ? '; Secure' : ''}`
const clearOauthStateCookie = (secure) => `${OAUTH_STATE_COOKIE}=; HttpOnly; Path=/api/auth/wechat/callback; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
const readJson = async (req) => {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > MAX_JSON) throw new HttpError(413, 'body_too_large'); chunks.push(chunk) }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body }
  catch { throw new HttpError(400, 'invalid_json') }
}
const verifyOrigin = (req, config) => { if (req.headers.origin !== config.appOrigin) throw new HttpError(403, 'origin_not_allowed') }
const getSession = (req, db, now) => {
  const token = cookies(req.headers.cookie)[COOKIE]
  if (!token || token.length > 256) return null
  const tokenHash = sha256(token)
  const row = db.prepare(`SELECT s.token_hash, s.expires_at, u.id, u.nickname, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.status = 'active'`).get(tokenHash)
  if (!row) return null
  if (row.expires_at <= now) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); return null }
  return { tokenHash, user: { id: row.id, nickname: row.nickname, avatarUrl: row.avatar_url } }
}
const requireUser = (req, db, now) => { const session = getSession(req, db, now); if (!session) throw new HttpError(401, 'authentication_required'); return session }
const wechatJson = async (fetchImpl, url) => {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('WeChat request failed')
  const body = await response.json()
  if (body.errcode) throw new Error('WeChat authorization rejected')
  return body
}
const findOrCreateUser = (db, profile, now) => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare("SELECT user_id FROM oauth_identities WHERE provider = 'wechat' AND openid = ?").get(profile.openid)
    const userId = existing?.user_id ?? randomUUID()
    if (!existing) {
      db.prepare('INSERT INTO users (id, nickname, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(userId, String(profile.nickname ?? '').slice(0, 120), String(profile.headimgurl ?? '').slice(0, 2048), now, now)
      db.prepare("INSERT INTO oauth_identities (id, user_id, provider, openid, unionid, created_at, updated_at) VALUES (?, ?, 'wechat', ?, ?, ?, ?)").run(randomUUID(), userId, profile.openid, typeof profile.unionid === 'string' ? profile.unionid : null, now, now)
    } else {
      db.prepare('UPDATE users SET nickname = ?, avatar_url = ?, updated_at = ? WHERE id = ?').run(String(profile.nickname ?? '').slice(0, 120), String(profile.headimgurl ?? '').slice(0, 2048), now, userId)
      db.prepare("UPDATE oauth_identities SET unionid = COALESCE(?, unionid), updated_at = ? WHERE provider = 'wechat' AND openid = ?").run(typeof profile.unionid === 'string' ? profile.unionid : null, now, profile.openid)
    }
    db.exec('COMMIT')
    return db.prepare('SELECT id, nickname, avatar_url FROM users WHERE id = ?').get(userId)
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
const wechatCallback = async (url, req, res, { db, config, fetchImpl, now }) => {
  const state = url.searchParams.get('state'), code = url.searchParams.get('code')
  if (!state || !code || cookies(req.headers.cookie)[OAUTH_STATE_COOKIE] !== state || !config.wechatAppId || !config.wechatAppSecret) { html(res, 400, config.appOrigin, false, { 'Set-Cookie': clearOauthStateCookie(config.secureCookies) }); return }
  const stateHash = sha256(state)
  const valid = db.prepare('SELECT state_hash FROM oauth_states WHERE state_hash = ? AND expires_at > ?').get(stateHash, now())
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(stateHash)
  if (!valid) { html(res, 400, config.appOrigin, false, { 'Set-Cookie': clearOauthStateCookie(config.secureCookies) }); return }
  try {
    const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
    tokenUrl.search = new URLSearchParams({ appid: config.wechatAppId, secret: config.wechatAppSecret, code, grant_type: 'authorization_code' }).toString()
    const token = await wechatJson(fetchImpl, tokenUrl)
    if (!token.openid || !token.access_token) throw new Error('Incomplete WeChat token')
    const profileUrl = new URL('https://api.weixin.qq.com/sns/userinfo')
    profileUrl.search = new URLSearchParams({ access_token: token.access_token, openid: token.openid, lang: 'zh_CN' }).toString()
    const profile = await wechatJson(fetchImpl, profileUrl)
    if (profile.openid !== token.openid) throw new Error('WeChat identity mismatch')
    const user = findOrCreateUser(db, profile, now())
    const sessionToken = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(sessionToken), user.id, now() + SESSION_TTL, now())
    html(res, 200, config.appOrigin, true, { 'Set-Cookie': [setCookie(sessionToken, config.secureCookies), clearOauthStateCookie(config.secureCookies)] })
  } catch { html(res, 502, config.appOrigin, false, { 'Set-Cookie': clearOauthStateCookie(config.secureCookies) }) }
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
  return http.createServer(async (req, res) => {
    const time = now()
    try {
      const url = new URL(req.url ?? '/', config.appOrigin), method = req.method ?? 'GET'
      if (method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true })
      if (method === 'GET' && url.pathname === '/api/auth/wechat/start') {
        if (!config.wechatAppId || !config.wechatRedirectUri) throw new HttpError(503, 'wechat_login_not_configured')
        const state = randomBytes(24).toString('hex')
        db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(time)
        db.prepare('INSERT INTO oauth_states (state_hash, expires_at, created_at) VALUES (?, ?, ?)').run(sha256(state), time + STATE_TTL, time)
        const authorize = new URL('https://open.weixin.qq.com/connect/qrconnect')
        authorize.search = new URLSearchParams({ appid: config.wechatAppId, redirect_uri: config.wechatRedirectUri, response_type: 'code', scope: 'snsapi_login', state }).toString()
        authorize.hash = 'wechat_redirect'
        return json(res, 200, { authorizeUrl: authorize.toString() }, { 'Set-Cookie': oauthStateCookie(state, config.secureCookies) })
      }
      if (method === 'GET' && url.pathname === '/api/auth/wechat/callback') { await wechatCallback(url, req, res, { db, config, fetchImpl, now }); return }
      if (method === 'GET' && url.pathname === '/api/auth/me') { const session = getSession(req, db, time); return json(res, 200, { user: session?.user ?? null }) }
      if (method === 'POST' && url.pathname === '/api/auth/logout') {
        verifyOrigin(req, config); const session = getSession(req, db, time)
        if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash)
        res.writeHead(204, { 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie(config.secureCookies) }); return res.end()
      }
      if (url.pathname === '/api/account/api-key' && method === 'GET') {
        const { user } = requireUser(req, db, time)
        const secret = db.prepare('SELECT ciphertext, iv, auth_tag FROM user_secrets WHERE user_id = ?').get(user.id)
        return json(res, 200, { apiKey: secret ? decryptSecret({ ciphertext: secret.ciphertext, iv: secret.iv, tag: secret.auth_tag }, config.encryptionKey) : null })
      }
      if (url.pathname === '/api/account/api-key' && method === 'PUT') {
        verifyOrigin(req, config); const { user } = requireUser(req, db, time); const body = await readJson(req)
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey || apiKey.length > 2048) throw new HttpError(400, 'invalid_api_key')
        const secret = encryptSecret(apiKey, config.encryptionKey)
        db.prepare(`INSERT INTO user_secrets (user_id, ciphertext, iv, auth_tag, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = excluded.updated_at`).run(user.id, secret.ciphertext, secret.iv, secret.tag, time)
        return json(res, 200, { saved: true })
      }
      if (url.pathname === '/api/account/api-key' && method === 'DELETE') {
        verifyOrigin(req, config); const { user } = requireUser(req, db, time)
        db.prepare('DELETE FROM user_secrets WHERE user_id = ?').run(user.id)
        return json(res, 200, { deleted: true })
      }
      if (method === 'GET' && url.pathname === '/api/backup/status') {
        const { user } = requireUser(req, db, time), backup = db.prepare('SELECT byte_size, updated_at FROM user_backups WHERE user_id = ?').get(user.id)
        return json(res, 200, { exists: Boolean(backup), byteSize: backup?.byte_size ?? 0, updatedAt: backup ? new Date(backup.updated_at).toISOString() : null })
      }
      if (method === 'PUT' && url.pathname === '/api/backup') {
        verifyOrigin(req, config); const { user } = requireUser(req, db, time)
        const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (!['application/zip', 'application/x-zip-compressed'].includes(contentType)) throw new HttpError(415, 'unsupported_backup_type')
        if (Number(req.headers['content-length'] ?? 0) > MAX_BACKUP) throw new HttpError(413, 'backup_too_large')
        const saved = await writeBackup(req, config.backupDir, user.id)
        try {
          await serializeBackup(user.id, async () => {
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
        const { user } = requireUser(req, db, time), backup = db.prepare('SELECT file_name, sha256 FROM user_backups WHERE user_id = ?').get(user.id)
        if (!backup) throw new HttpError(404, 'backup_not_found')
        const filePath = path.join(config.backupDir, backup.file_name)
        let info
        try { info = await stat(filePath) } catch { throw new HttpError(404, 'backup_not_found') }
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': info.size, 'Content-Disposition': 'attachment; filename="chat-demo-backup.zip"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Backup-SHA256': backup.sha256 })
        await pipeline(createReadStream(filePath), res); return
      }
      throw new HttpError(404, 'not_found')
    } catch (error) {
      if (res.headersSent) return res.destroy()
      const status = error instanceof HttpError ? error.status : 500, code = error instanceof HttpError ? error.code : 'internal_error'
      json(res, status, { error: { code } })
      if (!(error instanceof HttpError)) process.stderr.write(`[chat-demo-server] ${code}\n`)
    }
  })
}
