import { createRoot } from 'react-dom/client'
import { App as NativeApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { closeSearchPanel, useSearchPanel } from './components/search/searchPanelState.js'
import { closeMobileSider, useMobileSider } from './components/sider/mobileSiderState.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

if (Capacitor.getPlatform() === 'android') {
  void NativeApp.addListener('backButton', () => {
    if (document.querySelector('[aria-modal="true"]')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    } else if (useMobileSider.getState().open) {
      closeMobileSider()
    } else if (useSearchPanel.getState().entry) {
      closeSearchPanel()
    } else {
      void NativeApp.minimizeApp()
    }
  })
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
