import type { CapacitorConfig } from '@capacitor/cli'
import pkg from './package.json'

// Capgo mobile app: native plugin set for plugin doc QR previews.
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
    Env: {
      DEMO_API_URL: 'https://api.example.com',
      DEMO_TENANT_ID: 'capgo-plugin-preview',
    },
    DeviceIntegrity: {
      cloudProjectNumber: '123456789012',
    },
  },
  android: {
    webContentsDebuggingEnabled: true,
  },
}

export default config
