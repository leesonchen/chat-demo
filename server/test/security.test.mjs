import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, parseEncryptionKey, sha256 } from '../security.mjs'

test('AES-GCM secret encryption round-trips and rejects tampering', () => {
  const key = randomBytes(32)
  const encrypted = encryptSecret('sk-test-secret', key)
  assert.equal(decryptSecret(encrypted, key), 'sk-test-secret')
  assert.notEqual(encrypted.ciphertext, 'sk-test-secret')
  assert.throws(() => decryptSecret({ ...encrypted, ciphertext: Buffer.from('tampered').toString('base64') }, key))
})

test('encryption key accepts base64 or hex and enforces 32 bytes', () => {
  const key = randomBytes(32)
  assert.deepEqual(parseEncryptionKey(key.toString('base64')), key)
  assert.deepEqual(parseEncryptionKey(key.toString('hex')), key)
  assert.throws(() => parseEncryptionKey('short'))
})

test('session hashes are deterministic', () => {
  assert.equal(sha256('token'), sha256('token'))
  assert.notEqual(sha256('token'), sha256('other'))
})
