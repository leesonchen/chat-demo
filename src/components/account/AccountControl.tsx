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
  const [loginDialog, setLoginDialog] = useState<
    | { includeProfile: boolean }
    | { includeProfile: boolean; challenge: WechatLoginChallenge; qrDataUrl: string }
    | null
  >(null)
  const [brokenAvatar, setBrokenAvatar] = useState('')

  const generateQr = async () => {
    if (!loginDialog || 'challenge' in loginDialog) {
      return
    }
    const { includeProfile } = loginDialog
    try {
      const challenge = await beginWechatLogin(includeProfile)
      const qr = qrcode(0, 'M')
      qr.addData(challenge.authorizeUrl)
      qr.make()
      const qrDataUrl = qr.createDataURL(6, 4)
      setLoginDialog((current) =>
        current === loginDialog ? { includeProfile, challenge, qrDataUrl } : current
      )
    } catch {
      showToast({ key: 'wechatLoginFailed', type: 'error' })
    }
  }
  const closeScan = () => setLoginDialog(null)
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
    if (!loginDialog || !('challenge' in loginDialog)) {
      return
    }
    const { challenge, includeProfile } = loginDialog
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
          closeScan()
          showToast({ key: 'wechatLoggedIn' })
          if (useAuthStore.getState().needsKeyUpload || !useSettings.getState().apiKey) {
            openSettings('data')
          }
        }
      } catch (error) {
        if (!stopped) {
          setLoginDialog({ includeProfile: false })
          showToast({
            key: error instanceof Error && error.message === 'login_ticket_expired'
              ? 'wechatLoginExpired'
              : includeProfile ? 'wechatProfileFailed' : 'wechatLoginFailed',
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
  }, [loginDialog])

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
              <div className={styles.menuUser}>{t('wechatAccountSignedIn')}</div>
              <button type="button" role="menuitem" onClick={() => openSettings('data')}>{t('wechatAccountSettings')}</button>
              <button type="button" role="menuitem" onClick={onLogout}>{t('wechatLogout')}</button>
            </div>
          ) : null}
        </>
      ) : (
        <button type="button" className={styles.loginButton} disabled={loginBusy} onClick={() => setLoginDialog({ includeProfile: false })}>
          <span className={styles.avatar}>{t('wechatUser').slice(0, 1)}</span>
          {t('wechatLogin')}
        </button>
      )}
      {loginDialog ? (
        <Modal
          title={t('wechatScanTitle')}
          closable
          onClose={closeScan}
          className={styles.loginModal}
        >
          {'challenge' in loginDialog ? (
            <div className={styles.qrContent}>
              <img className={styles.qrCode} src={loginDialog.qrDataUrl} alt={t('wechatScanTitle')} />
              <div className={styles.qrInstruction}>
                {t(loginDialog.includeProfile ? 'wechatProfileInstructions' : 'wechatScanInstructions')}
              </div>
              <div className={styles.qrExpiry}>
                {t('wechatScanExpires', { minutes: Math.ceil(loginDialog.challenge.expiresIn / 60) })}
              </div>
              <Button variant="outlined" size="m" onClick={closeScan}>{t('cancel')}</Button>
            </div>
          ) : (
            <div className={styles.qrContent}>
              <label className={styles.profileOption}>
                <input
                  type="checkbox"
                  checked={loginDialog.includeProfile}
                  disabled={loginBusy}
                  onChange={(event) => setLoginDialog({ includeProfile: event.target.checked })}
                />
                {t('wechatProfileOption')}
              </label>
              <Button variant="outlined" size="m" disabled={loginBusy} onClick={generateQr}>
                {t(loginBusy ? 'wechatLoginOpening' : 'wechatShowQr')}
              </Button>
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  )
}
