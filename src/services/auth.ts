import { create } from 'zustand'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { setApiKey, useSettings } from './settings.js'

export type AuthUser = { id: string; nickname: string; avatarUrl: string }
type MembershipInfo = {
  tier: 'free' | 'member'
  validUntil: string | null
  cloudBackupAllowed: boolean
}

export type CloudBackupInfo = {
  exists: boolean
  byteSize: number
  updatedAt: string | null
  membership?: MembershipInfo
}
type AuthState = {
  ready: boolean
  user: AuthUser | null
  loginBusy: boolean
  wechatAppLoginAvailable: boolean
  wechatProfileSyncAvailable: boolean
  qqLoginAvailable: boolean
  pendingWechatAccount: string | null
  needsKeyUpload: boolean
  backupInfo: CloudBackupInfo | null
}
const API_KEY_OWNER = 'chat-demo:api-key-owner'
const MOBILE_WECHAT_PATH = '/api/auth/wechat/mobile'
const NativeWechat = registerPlugin<{
  authorize(options: { appId: string; state: string }): Promise<{
    status: 'ok' | 'cancelled' | 'not_installed' | 'failed'
    code?: string
  }>
}>('NativeWechat')
const hasNativeWechatLogin = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NativeWechat')
export const isWechatBrowser = () =>
  !Capacitor.isNativePlatform() && /MicroMessenger/i.test(navigator.userAgent)
export const isNativeApp = () => Capacitor.isNativePlatform()
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
const request = async <T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
      throw new Error(body?.error?.code ?? `http_${response.status}`)
    }
    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}
export const useAuthStore = create<AuthState>(() => ({
  ready: false, user: null, loginBusy: false, wechatAppLoginAvailable: false,
  wechatProfileSyncAvailable: true,
  qqLoginAvailable: false,
  pendingWechatAccount: null, needsKeyUpload: false, backupInfo: null,
}))

export const startMembershipTrial = async () => {
  const userId = useAuthStore.getState().user?.id
  const membership = await request<MembershipInfo>('/api/membership/trial', { method: 'POST' })
  useAuthStore.setState((state) =>
    state.user?.id === userId && state.backupInfo
      ? { backupInfo: { ...state.backupInfo, membership } }
      : state
  )
}

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
    const { user, wechatAppLoginAvailable, wechatProfileSyncAvailable, qqLoginAvailable } = await request<{
      user: AuthUser | null
      wechatAppLoginAvailable?: boolean
      wechatProfileSyncAvailable?: boolean
      qqLoginAvailable?: boolean
    }>(
      hasNativeWechatLogin() ? '/api/auth/me?client=android' : '/api/auth/me',
    )
    useAuthStore.setState({
      user,
      wechatAppLoginAvailable: wechatAppLoginAvailable === true,
      wechatProfileSyncAvailable: wechatProfileSyncAvailable !== false,
      qqLoginAvailable: qqLoginAvailable === true,
    })
    if (user) {
      await loadAccountData(user)
    }
  } catch {
    useAuthStore.setState({ user: null, backupInfo: null, qqLoginAvailable: false })
  } finally {
    useAuthStore.setState({ ready: true })
  }
}
export const beginWechatWebLogin = async (profile?: '1' | 'sync') => {
  if (useAuthStore.getState().loginBusy) {
    return
  }
  useAuthStore.setState({ loginBusy: true, pendingWechatAccount: null })
  try {
    const startPath = profile ? `/api/auth/wechat/start?profile=${profile}` : '/api/auth/wechat/start'
    const { authorizeUrl } = await request<{ authorizeUrl: string }>(startPath, {
      method: 'POST',
    })
    window.location.assign(authorizeUrl)
  } finally {
    useAuthStore.setState({ loginBusy: false })
  }
}
export const beginQqWebLogin = async () => {
  if (useAuthStore.getState().loginBusy) {
    return
  }
  useAuthStore.setState({ loginBusy: true, pendingWechatAccount: null })
  try {
    const { authorizeUrl } = await request<{ authorizeUrl: string }>('/api/auth/qq/start', { method: 'POST' })
    window.location.assign(authorizeUrl)
  } finally {
    useAuthStore.setState({ loginBusy: false })
  }
}
const postMobileWechat = <T>(action: string, body: object) => request<T>(`${MOBILE_WECHAT_PATH}/${action}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}, 15_000)
const restoreNativeWechatSession = async () => {
  await initAuth()
  if (!useAuthStore.getState().user) {
    throw new Error('wechat_login_failed')
  }
}
export const beginNativeWechatLogin = async (link = false) => {
  if (useAuthStore.getState().loginBusy) {
    return false
  }
  useAuthStore.setState({ loginBusy: true, pendingWechatAccount: null })
  try {
    const { appId, state } = await postMobileWechat<{ appId: string; state: string }>('start', { link })
    const result = await NativeWechat.authorize({ appId, state })
    if (result.status === 'cancelled') {
      return false
    }
    if (result.status === 'not_installed') {
      throw new Error('wechat_not_installed')
    }
    if (result.status !== 'ok' || !result.code) {
      throw new Error('wechat_login_failed')
    }

    const { needsAccount } = await postMobileWechat<{ needsAccount: boolean }>('finish', { state, code: result.code })
    if (needsAccount) {
      useAuthStore.setState({ pendingWechatAccount: state })
      return false
    }
    await restoreNativeWechatSession()
    return true
  } finally {
    useAuthStore.setState({ loginBusy: false })
  }
}
export const createNativeWechatAccount = async () => {
  const { loginBusy, pendingWechatAccount } = useAuthStore.getState()
  if (loginBusy || !pendingWechatAccount) {
    return false
  }
  useAuthStore.setState({ loginBusy: true, pendingWechatAccount: null })
  try {
    await postMobileWechat('create', { state: pendingWechatAccount })
    await restoreNativeWechatSession()
    return true
  } finally {
    useAuthStore.setState({ loginBusy: false })
  }
}
export const dismissNativeWechatAccount = () => useAuthStore.setState({ pendingWechatAccount: null })
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
  try {
    await request<{ saved: boolean }>('/api/account/api-key', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }),
    })
  } catch (error) {
    useAuthStore.setState({ needsKeyUpload: true })
    throw error
  }
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
  const userId = useAuthStore.getState().user?.id
  if (!userId) {
    useAuthStore.setState({ backupInfo: null })
    return null
  }
  try {
    const info = await request<CloudBackupInfo>('/api/backup/status')
    if (useAuthStore.getState().user?.id !== userId) {
      return null
    }
    useAuthStore.setState({ backupInfo: info })
    return info
  } catch { return null }
}
