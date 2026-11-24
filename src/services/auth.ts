import { create } from 'zustand'
import { setApiKey, useSettings } from './settings.js'

export type AuthUser = { id: string; nickname: string; avatarUrl: string }
export type CloudBackupInfo = { exists: boolean; byteSize: number; updatedAt: string | null }
type AuthState = {
  ready: boolean
  user: AuthUser | null
  loginBusy: boolean
  needsKeyUpload: boolean
  backupInfo: CloudBackupInfo | null
}
const API_KEY_OWNER = 'chat-demo:api-key-owner'
const readKeyOwner = () => { try { return localStorage.getItem(API_KEY_OWNER) } catch { return null } }
const writeKeyOwner = (userId: string | null) => {
  try {
    if (userId) {
      localStorage.setItem(API_KEY_OWNER, userId)
    } else {
      localStorage.removeItem(API_KEY_OWNER)
    }
  } catch {
    // optional marker
  }
}
const request = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: init.signal ?? AbortSignal.timeout(10000) })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
    throw new Error(body?.error?.code ?? `http_${response.status}`)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

export const useAuthStore = create<AuthState>(() => ({
  ready: false, user: null, loginBusy: false, needsKeyUpload: false, backupInfo: null,
}))

const loadAccountData = async (user: AuthUser) => {
  const owner = readKeyOwner()
  if (owner && owner !== user.id) {
    // Clear another account's locally cached key before any network request can fail.
    setApiKey(null)
    writeKeyOwner(null)
  }
  const localKey = useSettings.getState().apiKey
  useAuthStore.setState({ needsKeyUpload: Boolean(localKey) })
  try {
    const { apiKey } = await request<{ apiKey: string | null }>('/api/account/api-key')
    if (apiKey) {
      setApiKey(apiKey)
      writeKeyOwner(user.id)
      useAuthStore.setState({ needsKeyUpload: false })
    } else {
      // Legacy local keys have no owner marker: never upload them without an explicit user action.
      useAuthStore.setState({ needsKeyUpload: Boolean(localKey) })
    }
  } catch {
    // Keep account isolation even when the optional key endpoint is temporarily unavailable.
  }
  await refreshCloudBackupInfo()
}
export const initAuth = async () => {
  try {
    const { user } = await request<{ user: AuthUser | null }>('/api/auth/me')
    useAuthStore.setState({ user })
    if (user) {
      await loadAccountData(user)
    }
  } catch {
    useAuthStore.setState({ user: null, backupInfo: null })
  } finally {
    useAuthStore.setState({ ready: true })
  }
}
export const beginWechatLogin = async () => {
  const popup = window.open('about:blank', 'chat-demo-wechat-login', 'popup,width=520,height=680,resizable=yes,scrollbars=yes')
  if (!popup) {
    throw new Error('popup_blocked')
  }
  useAuthStore.setState({ loginBusy: true })
  try {
    const { authorizeUrl } = await request<{ authorizeUrl: string }>('/api/auth/wechat/start')
    popup.location.href = authorizeUrl
    let closedChecks = 0
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await request<{ user: AuthUser | null }>('/api/auth/me').catch(() => null)
      if (result?.user) {
        useAuthStore.setState({ user: result.user })
        await loadAccountData(result.user)
        if (!popup.closed) {
          popup.close()
        }
        return result.user
      }
      if (popup.closed && ++closedChecks >= 4) {
        throw new Error('login_cancelled')
      }
      await wait(1000)
    }
    throw new Error('login_timeout')
  } catch (error) {
    if (!popup.closed) {
      popup.close()
    }
    throw error
  } finally {
    useAuthStore.setState({ loginBusy: false })
  }
}
export const logout = async () => {
  await request<undefined>('/api/auth/logout', { method: 'POST' })
  useAuthStore.setState({ user: null, backupInfo: null, needsKeyUpload: false })
  // Keep the current local key for offline use; a later different-account login clears it.
}
export const saveApiKeyToCloud = async (apiKey: string) => {
  const user = useAuthStore.getState().user
  if (!user) {
    return
  }
  await request<{ saved: boolean }>('/api/account/api-key', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }),
  })
  writeKeyOwner(user.id)
  useAuthStore.setState({ needsKeyUpload: false })
}
export const saveCurrentApiKeyToCloud = async () => {
  const apiKey = useSettings.getState().apiKey
  if (!apiKey) {
    throw new Error('api_key_missing')
  }
  await saveApiKeyToCloud(apiKey)
}
export const dismissApiKeyUploadPrompt = () => useAuthStore.setState({ needsKeyUpload: false })
export const refreshCloudBackupInfo = async () => {
  if (!useAuthStore.getState().user) {
    useAuthStore.setState({ backupInfo: null })
    return null
  }
  try {
    const info = await request<CloudBackupInfo>('/api/backup/status')
    useAuthStore.setState({ backupInfo: info })
    return info
  } catch { return null }
}
