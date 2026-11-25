import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabase } from '../database.mjs'
import { membershipStatus, openMembershipOrder, settleMembershipOrder } from '../membership.mjs'

test('verified receipts extend membership once without letting duplicates or amounts unlock it', t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const january = Date.parse('2026-01-31T02:00:00Z')
  const february = Date.parse('2026-02-28T02:00:00Z')
  const march = Date.parse('2026-03-31T02:00:00Z')
  for (const id of ['user-a', 'user-b']) {
    db.prepare('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, january, january)
  }

  const first = openMembershipOrder(db, 'user-a', 'wechat', january)
  const receipt = { orderId: first, provider: 'wechat', transactionId: 'transaction-1', amountFen: 100, currency: 'CNY' }
  for (const mismatch of [{ amountFen: 1 }, { currency: 'USD' }, { provider: 'alipay' }]) {
    assert.throws(() => settleMembershipOrder(db, { ...receipt, ...mismatch }, january), /does not match/)
  }
  assert.equal(membershipStatus(db, 'user-a', january, 'required').tier, 'free')
  assert.equal(settleMembershipOrder(db, receipt, january), february)
  assert.equal(settleMembershipOrder(db, receipt, january + 1000), february)
  assert.throws(() => settleMembershipOrder(db, { ...receipt, transactionId: 'replacement' }, january), /already settled/)

  const other = openMembershipOrder(db, 'user-b', 'wechat', january)
  assert.throws(() => settleMembershipOrder(db, { ...receipt, orderId: other }, january), /UNIQUE/)
  assert.equal(membershipStatus(db, 'user-b', january, 'required').tier, 'free')

  const renewal = openMembershipOrder(db, 'user-a', 'alipay', february - 1)
  assert.equal(settleMembershipOrder(db, {
    ...receipt, orderId: renewal, provider: 'alipay', transactionId: 'renewal-1',
  }, february - 1), march)
  assert.equal(membershipStatus(db, 'user-a', march - 1, 'required').cloudBackupAllowed, true)
  assert.equal(membershipStatus(db, 'user-a', march, 'required').cloudBackupAllowed, false)
})
