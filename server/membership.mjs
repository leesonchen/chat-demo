import { randomBytes } from 'node:crypto'

export const MONTHLY_MEMBERSHIP = Object.freeze({
  id: 'cloud-backup-monthly',
  amountFen: 100,
  currency: 'CNY',
  interval: 'month',
})

// Keep the payment day stable across short months, using the merchant's China time.
const chinaOffset = 8 * 60 * 60 * 1000
const localDate = time => new Date(time + chinaOffset)
const nextMonth = (time, day) => {
  const date = localDate(time)
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + 1)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.getTime() - chinaOffset
}

const lastPaidPeriod = (db, userId) => db.prepare(`
  SELECT paid_until, billing_day FROM membership_orders
  WHERE user_id = ? AND status = 'paid'
  ORDER BY paid_until DESC LIMIT 1
`).get(userId)

export const membershipStatus = (db, userId, now, mode) => {
  const { paid_until: paidUntil } = lastPaidPeriod(db, userId) ?? {}
  return {
    tier: paidUntil > now ? 'member' : 'free',
    paidUntil: paidUntil ? new Date(paidUntil).toISOString() : null,
    plan: MONTHLY_MEMBERSHIP,
    mode,
    cloudBackupAllowed: mode !== 'required' || paidUntil > now,
  }
}

export const openMembershipOrder = (db, userId, provider, now) => {
  const id = randomBytes(16).toString('hex')
  const { amountFen, currency, id: plan } = MONTHLY_MEMBERSHIP
  db.prepare(`
    INSERT INTO membership_orders (id, user_id, provider, plan, amount_fen, currency, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, provider, plan, amountFen, currency, now)
  return id
}

// The payment adapter calls this only after authenticating a successful payment
// notice or obtaining the same result from the provider's order query.
export const settleMembershipOrder = (db, receipt, now) => {
  if (typeof receipt.transactionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.transactionId)) {
    throw new Error('Invalid provider transaction ID')
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const order = db.prepare('SELECT * FROM membership_orders WHERE id = ?').get(receipt.orderId)
    if (!order || order.provider !== receipt.provider || order.plan !== MONTHLY_MEMBERSHIP.id ||
        order.amount_fen !== receipt.amountFen || order.currency !== receipt.currency) {
      throw new Error('Payment does not match the membership order')
    }
    if (order.status === 'paid') {
      if (order.provider_transaction_id !== receipt.transactionId) {
        throw new Error('Order already settled under a different transaction')
      }
      db.exec('COMMIT')
      return order.paid_until
    }

    const last = lastPaidPeriod(db, order.user_id)
    const isRenewal = last?.paid_until > now
    const startsAt = isRenewal ? last.paid_until : now
    const billingDay = isRenewal ? last.billing_day : localDate(startsAt).getUTCDate()
    const paidUntil = nextMonth(startsAt, billingDay)
    db.prepare(`
      UPDATE membership_orders SET status = 'paid', provider_transaction_id = ?, paid_at = ?,
        period_starts_at = ?, paid_until = ?, billing_day = ?
      WHERE id = ?
    `).run(receipt.transactionId, now, startsAt, paidUntil, billingDay, order.id)
    db.exec('COMMIT')
    return paidUntil
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
