import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export const parseEncryptionKey = (value) => {
  if (!value) {
    throw new Error('API_KEY_ENCRYPTION_KEY is required')
  }
  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  if (key.length !== 32) {
    throw new Error('API_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes')
  }
  return key
}

export const encryptSecret = (value, key) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export const decryptSecret = ({ ciphertext, iv, tag }, key) => {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
