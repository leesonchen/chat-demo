import { createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { MONTHLY_MEMBERSHIP, openMembershipOrder, settleMembershipOrder } from './membership.mjs'

export const WECHAT_PAY_NOTIFY_PATH = '/api/payments/wechat/native/notify'
const origin = 'https://api.mch.weixin.qq.com'
const checkoutLifetime = 10 * 60_000
const signatureTolerance = 5 * 60_000

export const readWechatPayConfig = (env, appOrigin) => {
  const { WECHAT_PAY_APP_ID: appId, WECHAT_PAY_MCH_ID: mchId,
    WECHAT_PAY_MERCHANT_SERIAL: merchantSerial, WECHAT_PAY_MERCHANT_KEY_FILE: merchantKeyFile,
    WECHAT_PAY_API_V3_KEY_FILE: apiKeyFile, WECHAT_PAY_PLATFORM_KEY_ID: platformKeyId,
    WECHAT_PAY_PLATFORM_KEY_FILE: platformKeyFile } = env
  if (!env.WECHAT_PAY_ENABLED || env.WECHAT_PAY_ENABLED === '0') return null
  if (env.WECHAT_PAY_ENABLED !== '1' || !appOrigin.startsWith('https://') ||
      !/^wx[0-9a-f]{16}$/i.test(appId ?? '') || !/^\d{6,32}$/.test(mchId ?? '') ||
      !/^[0-9a-f]{1,64}$/i.test(merchantSerial ?? '') ||
      !/^(?:PUB_KEY_ID_\d+|[0-9a-fA-F]{1,64})$/.test(platformKeyId ?? '') ||
      !merchantKeyFile || !apiKeyFile || !platformKeyFile) {
    throw new Error('Invalid WeChat Native payment configuration')
  }
  const apiKey = readFileSync(apiKeyFile, 'utf8').trim()
  if (!/^[a-zA-Z0-9]{32}$/.test(apiKey)) throw new Error('Invalid WeChat Pay APIv3 key')
  const merchantKey = createPrivateKey(readFileSync(merchantKeyFile))
  const platformKey = createPublicKey(readFileSync(platformKeyFile))
  if ([merchantKey, platformKey].some(key =>
    key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048)) {
    throw new Error('WeChat Native requires RSA keys of at least 2048 bits')
  }
  return { appId, mchId, merchantSerial, merchantKey, platformKeyId, platformKey, apiKey }
}

export class WechatPayError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

const authenticated = (config, headers, raw, time) => {
  const serial = headers.get('wechatpay-serial')
  const timestamp = headers.get('wechatpay-timestamp') ?? ''
  const nonce = headers.get('wechatpay-nonce')
  const signature = headers.get('wechatpay-signature') ?? ''
  if (serial !== config.platformKeyId || !/^\d{10}$/.test(timestamp) ||
      Math.abs(time - Number(timestamp) * 1000) > signatureTolerance ||
      !nonce || !/^[a-zA-Z0-9+/]+={0,2}$/.test(signature)) return false
  const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), raw, Buffer.from('\n')])
  return verify('sha256', message, config.platformKey, Buffer.from(signature, 'base64'))
}

export const createWechatNative = ({ db, config, appOrigin, fetchImpl, now }) => {
  const inflight = new Map()
  const providerRequest = async (method, path, payload) => {
    const body = payload ? JSON.stringify(payload) : ''
    const timestamp = Math.floor(now() / 1000)
    const nonce = randomBytes(16).toString('hex')
    const signature = sign('sha256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), config.merchantKey).toString('base64')
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.merchantSerial}",signature="${signature}"`
    try {
      const response = await fetchImpl(origin + path, {
        method, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json',
          'Wechatpay-Serial': config.platformKeyId, 'User-Agent': 'chat-demo-payment/1.0' },
      })
      const raw = Buffer.from(await response.arrayBuffer())
      if (!response.ok || !authenticated(config, response.headers, raw, now())) throw new Error()
      return JSON.parse(raw.toString('utf8'))
    } catch {
      throw new WechatPayError(502, 'wechat_payment_unavailable')
    }
  }

  const findOrder = (userId, id) => db.prepare(`
    SELECT o.id, o.status, c.expires_at, c.code_url, c.closed, c.last_query_at
    FROM membership_orders o JOIN wechat_native_checkouts c ON c.order_id = o.id
    WHERE o.id = ? AND o.user_id = ?
  `).get(id, userId)

  const describe = order => {
    if (!order) throw new WechatPayError(404, 'payment_order_not_found')
    const status = order.status === 'paid' ? 'paid'
      : order.closed || order.expires_at <= now() ? 'expired' : 'pending'
    return { id: order.id, status, codeUrl: status === 'pending' ? order.code_url : null,
      expiresAt: new Date(order.expires_at).toISOString() }
  }

  const pendingOrder = (userId, time) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = db.prepare(`
        SELECT o.id FROM membership_orders o JOIN wechat_native_checkouts c ON c.order_id = o.id
        WHERE o.user_id = ? AND o.provider = 'wechat' AND o.status = 'pending'
          AND c.closed = 0 AND c.expires_at > ? ORDER BY o.created_at DESC LIMIT 1
      `).get(userId, time)
      const id = existing?.id ?? openMembershipOrder(db, userId, 'wechat', time)
      if (!existing) {
        db.prepare('INSERT INTO wechat_native_checkouts (order_id, expires_at) VALUES (?, ?)').run(id, time + checkoutLifetime)
      }
      db.exec('COMMIT')
      return findOrder(userId, id)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const placeOrder = async order => {
    const payload = {
      appid: config.appId,
      mchid: config.mchId,
      description: 'Chat Demo 云备份会员（一个月）',
      out_trade_no: order.id,
      time_expire: new Date(order.expires_at).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      notify_url: new URL(WECHAT_PAY_NOTIFY_PATH, appOrigin).href,
      amount: { total: MONTHLY_MEMBERSHIP.amountFen, currency: MONTHLY_MEMBERSHIP.currency },
    }
    const { code_url: codeUrl } = await providerRequest('POST', '/v3/pay/transactions/native', payload)
    if (typeof codeUrl !== 'string' || codeUrl.length > 1024 || !codeUrl.startsWith('weixin://wxpay/')) {
      throw new WechatPayError(502, 'wechat_payment_unavailable')
    }
    db.prepare('UPDATE wechat_native_checkouts SET code_url = ? WHERE order_id = ?').run(codeUrl, order.id)
  }

  const observe = (transaction, expectedId) => {
    const id = transaction.out_trade_no
    if (transaction.appid !== config.appId || transaction.mchid !== config.mchId ||
        !/^[a-f0-9]{32}$/.test(id ?? '') || (expectedId && id !== expectedId) ||
        !db.prepare('SELECT 1 FROM wechat_native_checkouts WHERE order_id = ?').get(id)) {
      throw new WechatPayError(400, 'payment_order_mismatch')
    }
    if (transaction.trade_state === 'SUCCESS') {
      if (transaction.trade_type !== 'NATIVE' || transaction.amount?.total !== MONTHLY_MEMBERSHIP.amountFen ||
          transaction.amount?.currency !== MONTHLY_MEMBERSHIP.currency) {
        throw new WechatPayError(400, 'payment_order_mismatch')
      }
      settleMembershipOrder(db, { orderId: id, provider: 'wechat', transactionId: transaction.transaction_id,
        amountFen: transaction.amount?.total, currency: transaction.amount?.currency }, now())
    } else if (['CLOSED', 'REVOKED', 'PAYERROR'].includes(transaction.trade_state)) {
      db.prepare('UPDATE wechat_native_checkouts SET closed = 1 WHERE order_id = ?').run(id)
    }
  }

  return {
    async start(userId) {
      const order = pendingOrder(userId, now())
      if (order.code_url) return describe(order)
      if (!inflight.has(order.id)) {
        inflight.set(order.id, placeOrder(order).finally(() => inflight.delete(order.id)))
      }
      await inflight.get(order.id)
      return describe(findOrder(userId, order.id))
    },
    status(userId, id) {
      return describe(findOrder(userId, id))
    },
    async refresh(userId, id) {
      const order = findOrder(userId, id)
      if (!order || order.status === 'paid' || order.closed) return describe(order)
      const time = now()
      const result = db.prepare(`
        UPDATE wechat_native_checkouts SET last_query_at = ?
        WHERE order_id = ? AND (last_query_at IS NULL OR last_query_at <= ?)
      `).run(time, id, time - 5000)
      if (result.changes) {
        const transaction = await providerRequest('GET', `/v3/pay/transactions/out-trade-no/${id}?mchid=${config.mchId}`)
        observe(transaction, id)
      }
      return describe(findOrder(userId, id))
    },
    notify(headers, raw) {
      if (!authenticated(config, headers, raw, now())) throw new WechatPayError(401, 'invalid_payment_signature')
      let transaction
      try {
        const { event_type: event, resource } = JSON.parse(raw.toString('utf8'))
        if (event !== 'TRANSACTION.SUCCESS' || resource.algorithm !== 'AEAD_AES_256_GCM' ||
            resource.original_type !== 'transaction') throw new Error()
        const data = Buffer.from(resource.ciphertext, 'base64')
        const decipher = createDecipheriv('aes-256-gcm', config.apiKey, resource.nonce)
        decipher.setAAD(Buffer.from(resource.associated_data ?? ''))
        decipher.setAuthTag(data.subarray(-16))
        transaction = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'))
        if (transaction.trade_state !== 'SUCCESS') throw new Error()
      } catch {
        throw new WechatPayError(400, 'invalid_payment_notification')
      }
      observe(transaction)
    },
  }
}
