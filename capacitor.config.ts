import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'top.leeson.deepseek.chat',
  appName: 'DeepSeek聊天助手',
  webDir: 'dist',
  android: {
    // Matches the Chromium target in rspack.config.ts.
    minWebViewVersion: 105,
  },
  server: {
    // Android serves the bundled assets at this origin. The Activity routes /api to the site.
    hostname: 'deepseek.leeson.top',
    androidScheme: 'https',
    errorPath: 'android-webview-error.html',
  },
}

export default config
