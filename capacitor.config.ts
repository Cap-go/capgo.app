import type { CapacitorConfig } from '@capacitor/cli'
import pkg from './package.json'

const config: CapacitorConfig = {
  appId: 'ee.forgr.capacitor_go',
  appName: 'Capgo',
  webDir: 'dist',
  plugins: {
    CapgoNotifications: {
      presentationOptions: [
        'badge',
        'sound',
        'alert',
      ],
    },
    PushNotifications: {
      presentationOptions: [
        'badge',
        'sound',
        'alert',
      ],
    },
    SplashScreen: {
      launchAutoHide: false,
      androidScaleType: 'CENTER_CROP',
    },
    CapacitorUpdater: {
      shakeMenu: true,
      shakeMenuGesture: 'threeFingerPinch',
      allowPreview: true,
      autoUpdate: 'atInstall',
      autoSplashscreen: true,
      version: pkg.version,
    },
  },
  android: {
    webContentsDebuggingEnabled: true,
  },
}

export default config
