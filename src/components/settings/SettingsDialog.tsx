import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconLoadingOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import {
  dismissApiKeyUploadPrompt,
  refreshCloudBackupInfo,
  saveCurrentApiKeyToCloud,
  startMembershipTrial,
  useAuthStore,
} from '../../services/auth.js'
import { exportHistoryToServer, prepareCloudBackup, type BackupDownloadProgress } from '../../services/cloudBackup.js'
import { formatSize } from '../../services/attachments.js'
import { transferAndroidFile, usesAndroidFiles } from '../../services/androidFiles.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  const historyImport = useHistoryImport()
  return open ? <SettingsContent historyImport={historyImport} /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key
  const apiKeyEditor = useApiKeyEditor()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            historyImport.dismiss()
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => {
                if (item.value !== 'data') {
                  historyImport.cancelCloud()
                }
                setSection(item.value)
              }}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <CloudKeyPrompt />
              <CloudMembership />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

const CloudKeyPrompt = () => {
  const t = useTranslate()
  const user = useAuthStore((state) => state.user)
  const needsUpload = useAuthStore((state) => state.needsKeyUpload)
  const apiKey = useSettings((state) => state.apiKey)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  if (!user || !needsUpload || !apiKey) {
    return null
  }
  const save = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      await saveCurrentApiKeyToCloud()
      setStatus({ key: 'apiKeyCloudSaved' })
      showToast({ key: 'apiKeyCloudSaved' })
    } catch {
      setStatus({ key: 'apiKeyCloudSaveFailed', error: true })
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingCell
      label={t('apiKeyCloudPrompt')}
      description={t('apiKeyCloudPromptDescription')}
      status={status}
      action={
        <>
          <Button variant="outlined" size="m" disabled={busy} onClick={dismissApiKeyUploadPrompt}>
            {t('skip')}
          </Button>
          <Button variant="outlined" size="m" disabled={busy} onClick={save}>
            {t(busy ? 'apiKeyVerifying' : 'saveToCloud')}
          </Button>
        </>
      }
    />
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={historyDelete.confirm}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={historyImport.confirm}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const cloudErrorStatus = (key: TranslationKey, error: unknown): Status => {
  if (error instanceof Error && error.message === 'membership_required') {
    return { key: 'cloudMembershipRequired', error: true }
  }
  if (error instanceof Error && error.message === 'backup_not_found') {
    return { key: 'cloudBackupMissing', error: true }
  }
  if (error instanceof Error && error.message === 'authentication_required') {
    return { key: 'cloudBackupAuthRequired', error: true }
  }
  if (error instanceof Error && error.message === 'backup_too_large') {
    return { key, reason: 'cloudBackupTooLarge', error: true }
  }
  if (error instanceof TypeError) {
    return { key, reason: 'cloudBackupInterrupted', error: true }
  }
  if (error instanceof Error && error.message.startsWith('http_')) {
    return { key, reason: 'cloudBackupServiceUnavailable', error: true }
  }
  return errorStatus(key, error)
}

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

const CloudMembership = () => {
  const t = useTranslate()
  const membership = useAuthStore((state) => state.backupInfo?.membership)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  useEffect(() => {
    void refreshCloudBackupInfo()
  }, [])
  if (!membership) {
    return null
  }

  const { tier, validUntil } = membership
  const beginTrial = async () => {
    setBusy(true)
    setStatus(null)
    try {
      await startMembershipTrial()
    } catch {
      setStatus({ key: 'cloudMembershipTrialFailed', error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t(tier === 'member' ? 'cloudMembershipActive' : 'cloudMembershipFree')}
      description={
        tier === 'member' && validUntil
          ? t('cloudMembershipValidUntil', { date: new Date(validUntil).toLocaleString() })
          : t('cloudMembershipTrialDescription')
      }
      status={status}
      action={
        tier === 'free' && (
          <Button
            size="m"
            variant="outlined"
            className={styles.cellButton}
            disabled={busy}
            aria-busy={busy}
            onClick={() => void beginTrial()}
          >
            {t('cloudMembershipStartTrial')}
          </Button>
        )
      }
    />
  )
}

type CloudRestore = { phase: 'downloading'; progress: BackupDownloadProgress } | { phase: 'ready' }
type CloudRestoreTask = { controller: AbortController; userId: string; file?: File }

const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<{ processed: number; total?: number } | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [cloud, setCloud] = useState<CloudRestore | null>(null)
  const importing = useRef(false)
  const cloudTask = useRef<CloudRestoreTask | null>(null)

  const cancelCloud = useCallback(() => {
    if (!cloudTask.current) {
      return
    }
    cloudTask.current.controller.abort()
    cloudTask.current = null
    setCloud(null)
  }, [])
  useEffect(() => {
    const unsubscribe = useAuthStore.subscribe((current, previous) => {
      if (current.user?.id !== previous.user?.id) {
        cancelCloud()
      }
    })
    return () => {
      unsubscribe()
      cloudTask.current?.controller.abort()
      cloudTask.current = null
    }
  }, [cancelCloud])

  const runImport = async (selected: File, fromCloud = false) => {
    if (importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setProgress({ processed: 0 })
    setStatus(null)
    try {
      const count = await importHistory(selected, (processed, total) => setProgress({ processed, total }))
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch (error) {
      setStatus(fromCloud ? cloudErrorStatus('cloudImportFailed', error) : { key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setProgress(null)
    }
  }
  const confirm = () => {
    if (!file) {
      return Promise.resolve()
    }
    return runImport(file)
  }

  const startCloud = async () => {
    const userId = useAuthStore.getState().user?.id
    if (!userId || file || cloudTask.current || importing.current) {
      return
    }
    const task: CloudRestoreTask = { controller: new AbortController(), userId }
    cloudTask.current = task
    setStatus(null)
    setCloud({ phase: 'downloading', progress: { received: 0 } })
    try {
      const prepared = await prepareCloudBackup(task.controller.signal, (download) => {
        if (cloudTask.current === task) {
          setCloud({ phase: 'downloading', progress: download })
        }
      })
      if (cloudTask.current === task) {
        task.file = prepared
        setCloud({ phase: 'ready' })
      }
    } catch (error) {
      if (cloudTask.current === task) {
        cloudTask.current = null
        setCloud(null)
        setStatus(cloudErrorStatus('cloudImportFailed', error))
        void refreshCloudBackupInfo()
      }
    }
  }
  const confirmCloud = () => {
    const task = cloudTask.current
    if (!task?.file || task.userId !== useAuthStore.getState().user?.id) {
      cancelCloud()
      return
    }
    cloudTask.current = null
    setCloud(null)
    void runImport(task.file, true)
  }

  return {
    file,
    busy: progress !== null || cloud !== null,
    progress,
    status,
    cloud,
    select: (selected: File) => {
      if (!cloudTask.current && !importing.current) {
        setFile(selected)
      }
    },
    cancel: () => setFile(null),
    dismiss: () => {
      setFile(null)
      setStatus(null)
      cancelCloud()
    },
    confirm,
    startCloud,
    cancelCloud,
    confirmCloud,
  }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const { cloud, progress } = historyImport
  const user = useAuthStore((state) => state.user)
  const backupInfo = useAuthStore((state) => state.backupInfo)
  const cloudDescription = backupInfo
    ? backupInfo.exists
      ? t('cloudBackupAvailable', { date: new Date(backupInfo.updatedAt ?? '').toLocaleString() })
      : t('cloudBackupNotAvailable')
    : t('historyImportDescription')

  const cloudAllowed = backupInfo?.membership?.cloudBackupAllowed !== false
  const canRestore = Boolean(user && backupInfo?.exists) && cloudAllowed && !disabled && !historyImport.busy
  const download = cloud?.phase === 'downloading' ? cloud.progress : null

  return (
    <>
      <SettingCell
        className={progress || download ? styles.importing : undefined}
        label={t('historyImport')}
        description={cloudAllowed ? cloudDescription : t('cloudMembershipRequired')}
        status={historyImport.status}
        action={
          <>
            {download ? (
              <Button variant="outlined" size="m" className={styles.cellButton} onClick={historyImport.cancelCloud}>
                {t('cloudBackupCancelDownload')}
              </Button>
            ) : (
              <Button
                variant="outlined"
                size="m"
                className={styles.cellButton}
                disabled={!canRestore}
                onClick={() => void historyImport.startCloud()}
              >
                {t(historyImport.status?.key === 'cloudImportFailed' ? 'retry' : 'cloudImport')}
              </Button>
            )}
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              aria-busy={historyImport.busy}
              aria-label={historyImport.busy ? t('historyImport') : undefined}
              disabled={disabled || historyImport.busy}
              onClick={() => inputRef.current?.click()}
            >
              {progress ? (
                <IconLoadingOutline16 />
              ) : (
                <>
                  <IconUploadOutline14 />
                  {t('upload')}
                </>
              )}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  historyImport.select(file)
                }
              }}
            />
            {download && (
              <div className={styles.cloudDownload}>
                <span role="status">{t(download.retrying ? 'cloudBackupRetrying' : 'cloudBackupDownloading')}</span>
                <div className={styles.importProgress}>
                  <progress
                    aria-label={t('cloudBackupDownloading')}
                    max={download.total}
                    value={download.total === undefined ? undefined : Math.min(download.received, download.total)}
                  />
                  <span>{formatSize(download.received)}{download.total && ` / ${formatSize(download.total)}`}</span>
                </div>
              </div>
            )}
            {progress?.total !== undefined && (
              <div className={styles.importProgress}>
                <div
                  className={styles.importTrack}
                  role="progressbar"
                  aria-label={t('historyImport')}
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.processed}
                >
                  <span
                    style={{
                      width: `${progress.total ? (progress.processed / progress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span>
                  {progress.processed} / {progress.total}
                </span>
              </div>
            )}
          </>
        }
      />
      {cloud?.phase === 'ready' ? (
        <Modal
          title={t('cloudImportConfirmTitle')}
          className={styles.importConfirm}
          onClose={historyImport.cancelCloud}
          footer={
            <>
              <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancelCloud}>
                {t('cancel')}
              </Button>
              <Button variant="dangerOutlined" size="m" onClick={historyImport.confirmCloud}>
                {t('cloudImport')}
              </Button>
            </>
          }
        >
          <div className={styles.importConfirmText}>{t('cloudImportConfirmDescription')}</div>
        </Modal>
      ) : null}
    </>
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const user = useAuthStore((state) => state.user)
  const backupInfo = useAuthStore((state) => state.backupInfo)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [confirmCloudExport, setConfirmCloudExport] = useState(false)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      if (usesAndroidFiles()) {
        await transferAndroidFile(blob, name)
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }
  const cloudAllowed = backupInfo?.membership?.cloudBackupAllowed !== false
  const onCloudExport = () => {
    if (!user || !cloudAllowed || busy) {
      return
    }
    setConfirmCloudExport(true)
  }
  const confirmExportToCloud = async () => {
    setConfirmCloudExport(false)
    if (!cloudAllowed) {
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      await exportHistoryToServer()
      setStatus({ key: 'cloudExportSuccess' })
    } catch (error) {
      setStatus(cloudErrorStatus('cloudExportFailed', error))
    } finally {
      setBusy(false)
      await refreshCloudBackupInfo()
    }
  }
  const description = backupInfo?.exists
    ? t('cloudBackupAvailable', { date: new Date(backupInfo.updatedAt ?? '').toLocaleString() })
    : t('historyExportDescription')

  return (
    <>
      <SettingCell
        label={t('exportAllLabel')}
        description={cloudAllowed ? description : t('cloudMembershipRequired')}
        status={status}
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={disabled || busy || empty || !user || !cloudAllowed}
              onClick={onCloudExport}
            >
              {t('cloudExport')}
            </Button>
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={disabled || busy || empty}
              onClick={onExport}
            >
              <IconDownloadOutline16 />
              {t('exportAllDownload')}
            </Button>
          </>
        }
      />
      {confirmCloudExport ? (
        <Modal
          title={t('cloudExportConfirmTitle')}
          className={styles.importConfirm}
          onClose={() => setConfirmCloudExport(false)}
          footer={
            <>
              <Button variant="outlined" size="m" autoFocus onClick={() => setConfirmCloudExport(false)}>
                {t('cancel')}
              </Button>
              <Button variant="dangerOutlined" size="m" onClick={confirmExportToCloud}>
                {t('cloudExport')}
              </Button>
            </>
          }
        >
          <div className={styles.importConfirmText}>{t('cloudExportConfirmDescription')}</div>
        </Modal>
      ) : null}
    </>
  )
}
