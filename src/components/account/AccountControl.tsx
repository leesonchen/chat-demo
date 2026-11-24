import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { beginWechatLogin, logout, useAuthStore } from '../../services/auth.js'
import { useSettings } from '../../services/settings.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { showToast } from '../base/toastState.js'
import styles from './AccountControl.module.css'

export const AccountControl = () => {
  const t = useTranslate()
  const user = useAuthStore((state) => state.user)
  const ready = useAuthStore((state) => state.ready)
  const loginBusy = useAuthStore((state) => state.loginBusy)
  const [menuOpen, setMenuOpen] = useState(false)

  const onLogin = async () => {
    try {
      await beginWechatLogin()
      if (useAuthStore.getState().needsKeyUpload || !useSettings.getState().apiKey) {
        openSettings('data')
      }
    } catch {
      showToast({ key: 'wechatLoginFailed', type: 'error' })
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
              {user.avatarUrl ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" /> : (user.nickname.slice(0, 1) || t('wechatUser').slice(0, 1))}
            </span>
            <span className={styles.nickname}>{user.nickname || t('wechatUser')}</span>
            <span className={styles.chevron}>⌃</span>
          </button>
          {menuOpen ? (
            <div className={styles.menu} role="menu">
              <div className={styles.menuUser}>{t('wechatAccountSignedIn')}</div>
              <button type="button" role="menuitem" onClick={() => openSettings('data')}>{t('wechatAccountSettings')}</button>
              <button type="button" role="menuitem" onClick={onLogout}>{t('wechatLogout')}</button>
            </div>
          ) : null}
        </>
      ) : (
        <button type="button" className={styles.loginButton} disabled={loginBusy} onClick={onLogin}>
          <span className={styles.avatar}>{t('wechatUser').slice(0, 1)}</span>
          {t(loginBusy ? 'wechatLoginOpening' : 'wechatLogin')}
        </button>
      )}
    </div>
  )
}
