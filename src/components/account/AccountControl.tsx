import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  beginNativeWechatLogin,
  beginQqWebLogin,
  beginWechatWebLogin,
  createNativeWechatAccount,
  dismissNativeWechatAccount,
  isNativeApp,
  isWechatBrowser,
  logout,
  useAuthStore,
} from '../../services/auth.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { showToast } from '../base/toastState.js'
import styles from './AccountControl.module.css'

// Reenable after QQ Connect approves the website application.
const qqEntryEnabled = false

export const AccountControl = () => {
  const t = useTranslate()
  const user = useAuthStore((state) => state.user)
  const ready = useAuthStore((state) => state.ready)
  const loginBusy = useAuthStore((state) => state.loginBusy)
  const pendingWechatAccount = useAuthStore((state) => state.pendingWechatAccount)
  const native = useAuthStore((state) => state.wechatAppLoginAvailable)
  const wechatProfileSyncAvailable = useAuthStore((state) => state.wechatProfileSyncAvailable)
  const qqLoginAvailable = useAuthStore((state) => state.qqLoginAvailable)
  const wechatBrowser = isWechatBrowser()
  const qqAppBrowser = /\bQQ\/[\d.]+/i.test(navigator.userAgent)
  const [menuOpen, setMenuOpen] = useState(false)
  const [brokenAvatar, setBrokenAvatar] = useState('')
  const [qqStarting, setQqStarting] = useState(false)

  const onQqLogin = async () => {
    setQqStarting(true)
    try {
      await beginQqWebLogin()
    } catch {
      showToast({ key: 'qqLoginFailed', type: 'error' })
    } finally {
      setQqStarting(false)
    }
  }

  const onLogin = async (action: 'native' | 'web' | 'profile' | 'sync' | 'link' | 'create') => {
    try {
      if (action === 'web' || action === 'profile' || action === 'sync') {
        await beginWechatWebLogin(action === 'profile' ? '1' : action === 'sync' ? 'sync' : undefined)
        return
      }
      const signedIn = action === 'create' ? await createNativeWechatAccount() : await beginNativeWechatLogin(action === 'link')
      if (signedIn) {
        setMenuOpen(false)
        showToast({ key: action === 'link' ? 'wechatAppLinked' : 'wechatLoggedIn' })
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      switch (code) {
        case 'wechat_not_installed':
          showToast({ key: 'wechatNotInstalled', type: 'error' })
          break
        case 'wechat_mobile_not_configured':
        case 'http_404':
          showToast({ key: 'wechatAppUnavailable', type: 'error' })
          break
        case 'wechat_account_conflict':
          showToast({ key: 'wechatAccountConflict', type: 'error' })
          break
        default:
          showToast({ key: action === 'sync' ? 'wechatProfileSyncFailed' : 'wechatLoginFailed', type: 'error' })
      }
    }
  }
  const onLogout = async () => {
    try {
      await logout()
      setMenuOpen(false)
      showToast({ key: 'wechatLoggedOut' })
    } catch {
      showToast({ key: 'wechatLogoutFailed', type: 'error' })
    }
  }

  if (!ready) {
    return null
  }
  return (
    <div className={styles.account}>
      {user ? (
        <>
          <button type="button" className={styles.accountButton} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <span className={styles.avatar}>
              {user.avatarUrl && user.avatarUrl !== brokenAvatar ? (
                <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setBrokenAvatar(user.avatarUrl)} />
              ) : (
                Array.from(user.nickname || t('wechatUser'))[0]
              )}
            </span>
            <span className={styles.nickname}>{user.nickname || t('wechatUser')}</span>
            <span className={styles.chevron}>⌃</span>
          </button>
          {menuOpen ? (
            <div className={styles.menu} role="menu">
              <div className={styles.menuUser}>{t('accountSignedIn')}</div>
              <button type="button" role="menuitem" onClick={() => openSettings('data')}>{t('wechatAccountSettings')}</button>
              {wechatBrowser && wechatProfileSyncAvailable && (
                <button type="button" role="menuitem" disabled={loginBusy} onClick={() => onLogin('sync')}>
                  {t(loginBusy ? 'wechatLoginOpening' : 'wechatSyncProfile')}
                </button>
              )}
              {native && (
                <button type="button" role="menuitem" disabled={loginBusy} onClick={() => onLogin('link')}>
                  {t(loginBusy ? 'wechatLoginOpening' : 'wechatLinkApp')}
                </button>
              )}
              <button type="button" role="menuitem" onClick={onLogout}>{t('wechatLogout')}</button>
            </div>
          ) : null}
        </>
      ) : (
        <div className={styles.signIn}>
          {pendingWechatAccount ? (
            <div className={styles.menuUser} role="status">{t('wechatAccountUnknown')}</div>
          ) : null}
          <button type="button" className={styles.loginButton} disabled={loginBusy} onClick={() =>
            onLogin(pendingWechatAccount ? 'create' : native ? 'native' : wechatBrowser ? 'profile' : 'web')
          }>
            <span className={styles.avatar}>{t('wechatUser').slice(0, 1)}</span>
            {t(loginBusy && !qqStarting ? 'wechatLoginOpening' : pendingWechatAccount ? 'wechatCreateAccount'
              : native ? 'wechatAppLogin' : wechatBrowser ? 'wechatLoginWithProfile' : 'wechatLogin')}
          </button>
          {wechatBrowser && (
            <div className={styles.loginOptions}>
              <button type="button" disabled={loginBusy} onClick={() => onLogin('web')}>{t('wechatLoginWithoutProfile')}</button>
            </div>
          )}
          {native && (
            <div className={styles.loginOptions}>
              <button type="button" disabled={loginBusy} onClick={() => onLogin('web')}>{t('wechatLoginWithQr')}</button>
              {pendingWechatAccount && (
                <button type="button" onClick={dismissNativeWechatAccount}>{t('wechatLoginCancel')}</button>
              )}
            </div>
          )}
          {qqEntryEnabled && qqLoginAvailable && !isNativeApp() && !wechatBrowser && !qqAppBrowser && (
            <div className={styles.loginOptions}>
              <button type="button" disabled={loginBusy} onClick={onQqLogin}>
                {t(qqStarting ? 'qqLoginOpening' : 'qqLogin')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
