import { sha256 } from '@noble/hashes/sha2.js'
import { BackupError, exportHistory } from './chat/backup.js'
import { refreshCloudBackupInfo, useAuthStore } from './auth.js'
import { throwIfAborted } from '../utils/abort.js'

const MAX_BACKUP_BYTES = 200 * 1024 * 1024
const DOWNLOAD_IDLE_MS = 30_000
const retryableStatus = new Set([408, 500, 502, 503, 504])

export type BackupDownloadProgress = {
  received: number
  total?: number
  retrying?: boolean
}

const ensureSignedIn = () => {
  if (!useAuthStore.getState().user) {
    throw new Error('authentication_required')
  }
}
const readError = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
  return body?.error?.code ?? `http_${response.status}`
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

const downloadBackup = async (
  signal: AbortSignal,
  onProgress: (progress: BackupDownloadProgress) => void,
): Promise<File> => {
  throwIfAborted(signal)
  const transfer = new AbortController()
  const cancelTransfer = () => transfer.abort()
  signal.addEventListener('abort', cancelTransfer, { once: true })
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const restartIdleTimer = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      cancelTransfer()
    }, DOWNLOAD_IDLE_MS)
  }

  try {
    restartIdleTimer()
    const response = await fetch('/api/backup?inline=1', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: transfer.signal,
    })
    if (retryableStatus.has(response.status)) {
      throw new BackupError('cloudBackupServiceUnavailable')
    }
    if (!response.ok) {
      throw new Error(await readError(response))
    }

    const expected = response.headers.get('X-Backup-SHA256')
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
      throw new BackupError('cloudBackupChecksumUnavailable')
    }
    const encoding = response.headers.get('Content-Encoding')
    const length = Number(response.headers.get('Content-Length'))
    const total = (!encoding || encoding === 'identity') && Number.isSafeInteger(length) && length > 0
      ? length
      : undefined
    if (total !== undefined && total > MAX_BACKUP_BYTES) {
      throw new BackupError('cloudBackupTooLarge')
    }
    if (!response.body) {
      throw new BackupError('cloudBackupEmpty')
    }

    const hash = sha256.create()
    let received = 0
    let lastProgress = 0
    onProgress({ received, total })
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        restartIdleTimer()
        received += chunk.byteLength
        if (received > MAX_BACKUP_BYTES) {
          throw new BackupError('cloudBackupTooLarge')
        }
        hash.update(chunk)
        const time = performance.now()
        if (time - lastProgress >= 100) {
          lastProgress = time
          onProgress({ received, total })
        }
        controller.enqueue(chunk)
      },
    }))
    // Let the browser materialize the ZIP as a Blob while hashing each chunk in flight.
    const blob = await new Response(stream).blob()
    throwIfAborted(signal)
    if (total !== undefined && blob.size !== total) {
      throw new BackupError('cloudBackupInterrupted')
    }
    if (!blob.size) {
      throw new BackupError('cloudBackupEmpty')
    }
    const actual = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('')
    if (actual !== expected.toLowerCase()) {
      throw new BackupError('cloudBackupChecksumMismatch')
    }
    onProgress({ received, total })
    return new File([blob], 'chat-demo-cloud-backup.zip', { type: 'application/zip' })
  } catch (error) {
    throwIfAborted(signal)
    if (timedOut) {
      throw new BackupError('cloudBackupTimedOut')
    }
    if (error instanceof TypeError) {
      throw new BackupError('cloudBackupInterrupted')
    }
    throw error
  } finally {
    clearTimeout(idleTimer)
    signal.removeEventListener('abort', cancelTransfer)
    cancelTransfer()
  }
}

const canRetry = (error: unknown) => error instanceof BackupError && (
  error.key === 'cloudBackupInterrupted' ||
  error.key === 'cloudBackupTimedOut' ||
  error.key === 'cloudBackupServiceUnavailable'
)

export const prepareCloudBackup = async (
  signal: AbortSignal,
  onProgress: (progress: BackupDownloadProgress) => void,
): Promise<File> => {
  ensureSignedIn()
  const file = await downloadBackup(signal, onProgress).catch((error: unknown) => {
    if (!canRetry(error)) {
      throw error
    }
    onProgress({ received: 0, retrying: true })
    return downloadBackup(signal, (progress) => onProgress({ ...progress, retrying: true }))
  })
  const { checkArchiveFormat } = await import('./chat/history/importArchive.js')
  throwIfAborted(signal)
  await checkArchiveFormat(file)
  throwIfAborted(signal)
  return file
}
