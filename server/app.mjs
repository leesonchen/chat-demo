import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { decryptSecret, encryptSecret, sha256 } from './security.mjs'

const SESSION_COOKIE = 'chat_demo_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const MAX_JSON_BYTES = 64 * 1024
const MAX_BACKUP_BYTES = 200 * 1024 * 1024

class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const sendJson = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

const sendHtml = (res, status, html, headers = {}) => {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  })
  res.end(html)
}

const callbackPage = (origin, success) => {
  const target = JSON.stringify(origin)
  const message = success ? 'Login completed. You can close this window.' : 'WeChat login failed. Please close this window and try again.'
  const event = success ? 'chat-demo-auth-complete' : 'chat-demo-auth-failed'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat Demo Login</title></head><body><p>${message}</p><script>if(window.opener){window.opener.postMessage({type:${JSON.stringify(event)}},${target});}window.close();</script></body></html>`
}

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]
      })
  )

const cookieHeader = (token, secure) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`

const clearCookieHeader = (secure) =>
  `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`

const readJson = async (req) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BYTES) {
      throw new HttpError(413, 'body_too_large')
    }
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected object')
    }
    return value
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

const verifyOrigin = (req, config) => {
  if (req.headers.origin !== config.appOrigin) {
    throw new HttpError(403, 'origin_not_allowed')
  }
}

const getSession = (req, db, now) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token || token.length > 256) {
    return null
  }
  const tokenHash = sha256(token)
  const session = db.prepare(`
    SELECT s.token_hash, s.expires_at, u.id, u.nickname, u.avatar_url
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.status = 'active'
  `).get(tokenHash)
  if (!session) {
    return null
  }
  if (session.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }
  return {
    tokenHash,
    user: {
      id: session.id,
      nickname: session.nickname,
      avatarUrl: session.avatar_url,
    },
  }
}

const requireUser = (req, db, now) => {
  const session = getSession(req, db, now)
  if (!session) {
    throw new HttpError(401, 'authentication_required')
  }
  return session
}

const fetchWechatJson = async (fetchImpl, url) => {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) {
    throw new Error('WeChat service request failed')
  }
  const value = await response.json()
  if (value.errcode) {
    throw new Error('WeChat authorization was rejected')
  }
  return value
}

const findOrCreateWechatUser = (db, profile, now) => {
  const { openid, unionid, nickname, headimgurl } = profile
  db.exec('BEGIN IMMEDIATE')
  try {
    let identity = db.prepare(`
      SELECT user_id FROM oauth_identities WHERE provider = 'wechat' AND openid = ?
    `).get(openid)
    let userId = identity?.user_id
    if (!userId) {
      userId = randomUUID()
      db.prepare(`
        INSERT INTO users (id, nickname, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, typeof nickname === 'string' ? nickname.slice(0, 120) : '', typeof headimgurl === 'string' ? headimgurl.slice(0, 2048) : '', now, now)
      db.prepare(`
        INSERT INTO oauth_identities (id, user_id, provider, openid, unionid, created_at, updated_at)
        VALUES (?, ?, 'wechat', ?, ?, ?, ?)
      `).run(randomUUID(), userId, openid, typeof unionid === 'string' ? unionid : null, now, now)
    } else {
      db.prepare(`
        UPDATE users SET nickname = ?, avatar_url = ?, updated_at = ? WHERE id = ?
      `).run(typeof nickname === 'string' ? nickname.slice(0, 120) : '', typeof headimgurl === 'string' ? headimgurl.slice(0, 2048) : '', now, userId)
      db.prepare(`
        UPDATE oauth_identities SET unionid = COALESCE(?, unionid), updated_at = ?
        WHERE provider = 'wechat' AND openid = ?
      `).run(typeof unionid === 'string' ? unionid : null, now, openid)
    }
    db.exec('COMMIT')
    return db.prepare('SELECT id, nickname, avatar_url FROM users WHERE id = ?').get(userId)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const handleWechatCallback = async (url, res, { db, config, fetchImpl, now }) => {
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (!state || !code || !config.wechatAppId || !config.wechatAppSecret) {
    sendHtml(res, 400, callbackPage(config.appOrigin, false))
    return
  }
  const stateHash = sha256(state)
  const savedState = db.prepare('SELECT state_hash FROM oauth_states WHERE state_hash = ? AND expires_at > ?').get(stateHash, now())
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(stateHash)
  if (!savedState) {
    sendHtml(res, 400, callbackPage(config.appOrigin, false))
    return
  }
  try {
    const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
    tokenUrl.search = new URLSearchParams({
      appid: config.wechatAppId,
      secret: config.wechatAppSecret,
      code,
      grant_type: 'authorization_codeg/
    }).toString()
    const token = await fetchWechatJson(fetchImpl, tokenUrl)
    if (!token.openid || !token.access_token) {
      throw new Error('WeChat token response is incomplete')
    }
    const profileUrl = new URL('https://api.weixin.qq.com/sns/userinfo')
    profileUrl.search = new URLSearchParams({
      access_token: token.access_token,
      openid: token.openid,
      lang: 'zh_CN',
    }).toString()
    const profile = await fetchWeChatJson(fetchImpl, profileUrl)
    if (profile.openid !== token.openid) {
      throw new Error('WeChat identity mismatch')
    }
    const user = findOrCreateWeChatUser(db, profile, now())
    const sessionToken = randomBytes(32).toString('base64url')
    const expiresAt = now() + SESSION_TTL_MS
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(sessionToken), user.id, expiresAt, now())
    sendHtml(res, 200, callbackPage(config.appOrigin, true), {
      'Set-Cookie': cookieHeader(sessionToken, config.secureCookies),
    })
  } catch {
    sendHtml(res, 502, callbackPage(config.appOrigin, false))
  }
}

const writeBackupFile = async (req, backupDir, userId) => {
  await mkdir(backupDir, { recursive: true })
  const fileName = `${userId}.${randomUUID()}.zip`
  const destination = path.join(backupDir, fileName)
  const temporary = `${destination}.tmp`
  let size = 0
  let prefix = Buffer.alloc(0)
  const digest = createHash('sha256')
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length
      if (size > MAX_BACKUP_BYTES) {
        callback(new HttpError(413, 'backup_too_large'))
        return
      }
      if (prefix.length < 4) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.length)])
      }
      digest.update(chunk)
      callback(null, chunk)
    }
  })
  try {
    await pipeline(req, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0x600}))
    if (prefix.length < 4 || prefix[0] !== 0x50 || prefix[1] !== 0x4b || prefix[2] !== 0x03 || prefix[3] !== 0x04) {
      throw new HttpError(400, 'invalid_backup_archive')
    }
    await rename(temporary, destination)
    return { fileName, byteSize: size, digest: digest.digest('hex'), destination }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    await rm(destination, { force: true }).catch(() => {})
    throw error
  }
}

export const createAppServer = ({ db, config, fetchImpl = fetch, now = Date.now }) => {
  if (!db || !config.appOrigin || !config.backupDir || !config.encryptionKey) {
    throw new Error('Database, appOrigin, backupDir, and encryptionKey are required')
  }

  return http.createServer(async (req, res) => {
    const currentTime = now()
    try {
      const url = new URL(req.url ?? '/', config.appOrigin)
      const method = req.method ?? 'GET'

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true })
        return
      }

      if (method === 'GET' && url.pathname === '/api/auth/wechat/start') {
        if (!config.wechatAppId || !config.wechatRedirectUri) {
          throw new HttpError(503, 'wechat_login_not_configured')
        }
        const state = randomBytes(24).toString('hex')
        db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(currentTime)
        db.prepare('INSERT INTO oauth_states (state_hash, expires_at, created_at) VALUES (?, ?, ?)')
          .run(sha256(state), currentTime + OAUTH_STATE_TTL_MS, currentTime)
        const authorizeUrl = new URL('https://open.weixin.qq.com/connect/qrconnect')
        authorizeUrl.search = new URLSearchParams({
          appid: config.wechatAppId,
          redirect_uri: config.wechatRedirectUri,
          response_type: 'code',
          scope: 'snsapi_login',
          state,
        }).toString()
        authorizeUrl.hash = 'wechat_redirect'
        sendJson(res, 200, { authorizeUrl: authorizeUrl.toString() })
        return
      }

      if (method === 'GET' && url.pathname === '/api/auth/wechat/callback') {
        await handleWeChatCallback(url, res, { db, config, fetchImpl, now })
        return
      }

      if (method === 'GET' && url.pathname === '/api/auth/me') {
        const session = getSession(req, db, currentTime)
        sendJson(res, 200, { user: session?.user ?? null })
        return
      }

      if (method === 'POST' && url.pathname === '/api/auth/logout') {
        verifyOrigin(req, config)
        const session = getSession(req, db, currentTime)
        if (session) {
          db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash)
        }
        res.writeHead(204, {
          'Cache-Control': 'no-store',
          'Set-Cookie': clearCookieHeader(config.secureCookies),
        })
        res.end()
        return
      }

      if (url.pathname === '/api/account/api-key' && method === 'GET') {
        const { user } = requireUser(req, db, currentTime)
        const secret = db.prepare('SELECT ciphertext, iv, auth_tag FROM user_secrets WHERE user_id = ?').get(user.id)
        sendJson(res, 200, { apiKey: secret ? decryptSecret({ ciphertext: secret.ciphertext, iv: secret.iv, tag: secret.auth_tag }, config.encryptionKey) : null })
        return
      }

      if (url.pathname === '/api/account/api-key' && method === 'PUT') {
        verifyOrigin(req, config)
        const { user } = requireUser(req, db, currentTime)
        const body = await readJson(req)
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey || apiKey.length > 2048) {
          throw new HttpError(400, 'invalid_api_key')
        }
        const encrypted = encryptSecret(apiKey, config.encryptionKey)
        db.prepare(`
          INSERT INTO user_secrets (user_id, ciphertext, iv, auth_tag, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            iv = excluded.iv,
            auth_tag = excluded.auth_tag,
            updated_at = excluded.updated_at
        `).run(user.id, encrypted.ciphertext, encrypted.iv, encrypted.tag, currentTime)
        sendJson(res, 200, { saved: true })
        return
      }

      if (url.pathname === '/api/account/api-key' && method === 'DELETE') {
        verifyOrigin(req, config)
        const { user } = requireUser(req, db, currentTime)
        db.prepare('DELETE FROM user_secrets WHERE user_id = ?').run(user.id)
        sendJson(res, 200, { deleted: true })
        return
      }

      if (url.pathname === '/api/backup/status' && method === 'GET') {
        const { user } = requireUser(req, db, currentTime)
        const backup = db.prepare('SELECT byte_size, updated_at FROM user_backups WHERE user_id = ?').get(user.id)
        sendJson(res, 200, {
          exists: Boolean(backup),
          byteSize: backup?.byte_size ?? 0,
          updatedAt: backup ? new Date(backup.updated_at).toISOString() : null,
        })
        return
      }

      if (url.pathname === '/api/backup' && method === 'PUT') {
        verifyOrigin(req, config)
        const { user } = requireUser(req, db, currentTime)
        const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (contentType !== 'application/zip' && contentType !== 'application/x-zip-compressed') {
          throw new HttpError(415, 'unsupported_backup_type')
        }
        const contentLength = Number(req.headers['content-length'] ?? 0)
        if (contentLength > MAX_BACKUP_BYTES"’°¢F‡&÷ræWr‡GGW'&÷"ƒC2Âv&6·W÷FöõöÆ&vRr¢Ğ¢6öç7B6fVBÒv—Bw&—FT&6·Wf–ÆR‡&WÂ6öæf–ræ&6·WF—"ÂW6W"æ–B¢6öç7B&Wf–÷W2ÒF"ç&W&R‚u4TÄT5Bf–ÆUöæÖRe$ôÒW6W%ö&6·W2t„U$RW6W%ö–BÒòr’ævWB‡W6W"æ–B¢G'’°¢F"ç&W&R† ¢”å4U%B”åDòW6W%ö&6·W2‡W6W%ö–BÂf–ÆUöæÖRÂ'—FU÷6—¦RÂ6†#SbÂWFFVEöB¢dÅTU2ƒòÂòÂòÂòÂò¢ôâ4ôädÄ”5B‡W6W%ö–B’DòUDDR4U@¢f–ÆUöæÖRÒW†6ÇVFVBæf–ÆUöæÖRÀ¢'—FU÷6—¦RÒW†6ÇVFVBæ'—FU÷6—¦RÀ¢6†#SbÒW†6ÇVFVBç6†#SbÀ¢WFFVEöBÒW†6ÇVFVBçWFFVEö@¢’ç'Vâ‡W6W"æ–BÂ6fVBæf–ÆTæÖRÂ6fVBæ'—FU6—¦RÂ6fVBæF–vW7BÂ7W'&VçEF–ÖR¢Ò6F6‚†W'&÷"’°¢v—B&Ò‡6fVBæFW7F–æF–öâÂ²f÷&6S¢G'VRÒ’æ6F6‚‚‚’Óâ·Ò¢F‡&÷rW'&÷ ¢Ğ¢–b‡&Wf–÷W3òæf–ÆUöæÖR’°¢v—B&Ò‡F‚æ¦ö–â†6öæf–ræ&6·WF—"Â&Wf–÷W2æf–ÆUöæÖR’Â²f÷&6S¢G'VRÒ’æ6F6‚‚‚’Óâ·Ò¢Ğ¢6VæD§6öâ‡&W2Â#Â²6fVC¢G'VRÂ'—FU6—¦S¢6fVBæ'—FU6—¦RÂWFFVDC¢æWrFFR†7W'&VçEF–ÖR’çFô•4õ7G&–ær‚’Ò¢&WGW&à¢Ğ ¢–b‡W&ÂçF†æÖRÓÓÒrö’ö&6·WrbbÖWF†öBÓÓÒttUBr’°¢6öç7B²W6W"ÒÒ&WV—&UW6W"‡&WÂF"Â7W'&VçEF–ÖR¢6öç7B&6·WÒF"ç&W&R‚u4TÄT5Bf–ÆUöæÖRÂ'—FU÷6—¦RÂ6†#Sbe$ôÒW6W%ö&6·W2t„U$RW6W%ö–BÒòr’ævWB‡W6W"æ–B¢–b‚&6·W’°¢F‡&÷ræWr‡GGW'&÷"ƒCBÂv&6·Wöæ÷Eöf÷VæBr¢Ğ¢6öç7Bf–ÆUF‚ÒF‚æ¦ö–â†6öæf–ræ&6·WF—"Â&6·Wæf–ÆUöæÖR¢ÆWBf–ÆU7F@¢G'’°¢f–ÆU7FBÒv—B7FB†f–ÆUF‚¢Ò6F6‚°¢F‡&÷ræWr‡GGW'&÷"ƒCBÂv&6·Wöæ÷Eöf÷VæBr¢Ğ¢&W2çw&—FT†VBƒ#Â°¢t6öçFVçBÕG—Rs¢vÆ–6F–öâ÷¦—rÀ¢t6öçFVçBÔÆVæwF‚s¢f–ÆU7FBç6—¦RÀ¢t6öçFVçBÔF—7÷6—F–öâs¢vGF6†ÖVçC²f–ÆVæÖSÒ&6†BÖFVÖòÖ&6·Wç¦—"rÀ¢t66†RÔ6öçG&öÂs¢væò×7F÷&RrÀ¢u‚Ô6öçFVçBÕG—RÔ÷F–öç2s¢væ÷6æ–fbrÀ¢u‚Ô&6·WÕ4„#Sbs¢&6·Wç6†#SbÀ¢Ò¢v—B—VÆ–æR†7&VFU&VE7G&VÒ†f–ÆUF‚’Â&W2¢&WGW&à¢Ğ ¢F‡&÷ræWr‡GGW'&÷"ƒCBÂvæ÷Eöf÷VæBr¢Ò6F6‚†W'&÷"’°¢–b‡&W2æ†VFW'56VçB’°¢&W2æFW7G&÷’‚¢&WGW&à¢Ğ¢6öç7B7FGW2ÒW'&÷"–ç7Fæ6Vöb‡GGW'&÷"òW'&÷"ç7FGW2¢S ¢6öç7B6öFRÒW'&÷"–ç7Fæ6Vöb‡GGW'&÷"òW'&÷"æ6öFR¢v–çFW&æÅöW'&÷"p¢6VæD§6öâ‡&W2Â7FGW2Â²W'&÷#¢²6öFRÒÒ¢–b‚†W'&÷"–ç7Fæ6Vöb‡GGW'&÷"’’°¢òò¶VW&WVW7BÆöw2g&VRöb&WVW7B&öF–W2Â6öö¶–W2ÂôWF‚6öFW2ÂæB’¶W—2à¢&ö6W72ç7FFW'"çw&—FR†¶6†BÖFVÖò×6W'fW%ÒG¶6öFWÕÆæ¢Ğ¢Ğ¢Ò§Ğ 