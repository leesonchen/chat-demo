import { useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { useTranslate } from '../../i18n/index.js'
import { beginWechatLogin, logout, pollWechatLogin, useAuthStore, type WechatLoginChallenge } from '../../services/auth.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { showToast } from '../base/toastState.js'
import styles from './AccountControl.module.css'

export const AccountControl = () => {
  const t = useTranslate()
  const user = useAuthStore((state) => state.user)
  const ready = useAuthStore((state) => state.ready)
  const loginBusy = useAuthStore((state) => state.loginBusy)
  const [menuOpen, setMenuOpen] = useState(false)
  const [challenge, setChallenge] = useState<WechatLoginChallenge | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  const onLogin = async () => {
    try {
      const next = await beginWechatLogin()
      const qr = qrcode(0, 'M')
      qr.addData(next.authorizeUrl)
      qr.make()
      setQrDataUrl(qr.createDataURL(6, 4))
      setChallenge(next)
    } catch {
      showToast({ key: 'wechatLoginFailed', type: 'error' })
    }
  }
  const closeLogin = () => {
    setChallenge(null)
    setQrDataUrl(null)
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

  useEffect(() => {
    if (!challenge) {
      return
    }
    let stopped = false
    let polling = false
    const poll = async () => {
      if (stopped || polling) {
        return
      }
      polling = true
      try {
        const authenticatedUser = await pollWechatLogin(challenge)
        if (authenticatedUser && !stopped) {
          closeLogin()
          showToast({ key: 'wechatLoggedIn' })
          if (useAuthStore.getState().needsKeyUpload || !useSettings.getState().apiKey) {
            openSettings('data')
          }
        }
      } catch (error) {
        if (!stopped) {
          closeLogin()
          showToast({
            key: error instanceof Error && error.message === 'login_ticket_expired'
              ? 'wechatLoginExpired'
              : 'wechatLoginFailed',
            type: 'error',
          })
        }
      } finally {
        polling = false
      }
    }
    const timer = window.setInterval(() => {
      poll().catch(() => {})
    }, 1500)
    poll().catch(() => {})
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [challenge])

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
      {challenge && qrDataUrl ? (
        <Modal
          title={t('wechatScanTitle')}
          closable
          onClose={closeLogin}
          className={styles.loginModal}
        >
          <div className={styles.qrContent}>
            <img className={styles.qrCode} src={qrDataUrl} alt={t('wechatScanTitle')} />
            <div className={styles.qrInstruction}>{t('wechatScanInstructions')}</div>
            <div className={styles.qrExpiry}>{t('wechatScanExpires', { minutes: Math.ceil(challenge.expiresIn / 60) })}</div>
            <Button variant="outlined" size="m" onClick={closeLogin}>{t('cancel')}</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
