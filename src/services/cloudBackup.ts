import { exportHistory, importHistory } from './chat/backup.js'
import type { ImportProgressCallback } from './chat/history/importArchive.js'
import { refreshCloudBackupInfo, useAuthStore } from './auth.js'

const ensureSignedIn = () => {
  if (!useAuthStore.getState().user) {
    throw new Error('authentication_required')
  }
}
const readError = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
  return body?.error?.code ?? `http_${response.status}`
}
const digest = async (blob: Blob) => {
  if (!globalThis.crypto?.subtle) {
    return null
  }
  const bytes = await blob.arrayBuffer()
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('')
}
export const exportHistoryToServer = async () => {
  ensureSignedIn()
  const { blob } = await exportHistory()
  const response = await fetch('/api/backup', {
    method: 'PUT', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/zip' }, body: blob,
  })
  if (!response.ok) {
    throw new Error(await readError(response))
  }
  await refreshCloudBackupInfo()
}
export const importHistoryFromServer = async (onProgress?: ImportProgressCallback) => {
  ensureSignedIn()
  const response = await fetch('/api/backup', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) {
    throw new Error(await readError(response))
  }
  const blob = await response.blob()
  if (!blob.size) {
    throw new Error('empty_backup')
  }
  const expected = response.headers.get('X-Backup-SHA256')
  if (expected) {
    const actual = await digest(blob)
    if (actual && actual !== expected) {
      throw new Error('backup_checksum_mismatch')
    }
  }
  const file = new File([blob], 'chat-demo-cloud-backup.zip', { type: 'application/zip' })
  return importHistory(file, onProgress)
}
