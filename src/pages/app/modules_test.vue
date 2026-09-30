<script setup lang="ts">
import { registerPlugin } from '@capacitor/core'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconNext from '~icons/ic/round-keyboard-arrow-right'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const displayStore = useDisplayStore()

interface PluginTest {
  packageName: string
  pluginName: string
  method: string
  label: string
  option?: Record<string, unknown>
}

interface PluginNote {
  packageName: string
  reason: string
}

type NativePlugin = Record<string, (...args: unknown[]) => Promise<unknown>>

const pluginCache = new Map<string, NativePlugin>()
const lastResults = ref<Record<string, string>>({})

const pluginTests: PluginTest[] = [
  { packageName: '@capgo/camera-preview', pluginName: 'CameraPreview', method: 'getPluginVersion', label: 'camera-preview' },
  { packageName: '@capgo/capacitor-accelerometer', pluginName: 'CapacitorAccelerometer', method: 'getPluginVersion', label: 'capacitor-accelerometer' },
  { packageName: '@capgo/capacitor-age-range', pluginName: 'AgeRange', method: 'getPluginVersion', label: 'capacitor-age-range' },
  { packageName: '@capgo/capacitor-android-age-signals', pluginName: 'AgeSignals', method: 'getPluginVersion', label: 'capacitor-android-age-signals' },
  { packageName: '@capgo/capacitor-android-inline-install', pluginName: 'AndroidInlineInstall', method: 'getPluginVersion', label: 'capacitor-android-inline-install' },
  { packageName: '@capgo/capacitor-android-kiosk', pluginName: 'CapacitorAndroidKiosk', method: 'getPluginVersion', label: 'capacitor-android-kiosk' },
  { packageName: '@capgo/capacitor-android-sms-retriever', pluginName: 'AndroidSmsRetriever', method: 'getPluginVersion', label: 'capacitor-android-sms-retriever' },
  { packageName: '@capgo/capacitor-android-usagestatsmanager', pluginName: 'CapacitorUsageStatsManager', method: 'getPluginVersion', label: 'capacitor-android-usagestatsmanager' },
  { packageName: '@capgo/capacitor-app-attest', pluginName: 'AppAttest', method: 'isSupported', label: 'capacitor-app-attest' },
  { packageName: '@capgo/capacitor-app-tracking-transparency', pluginName: 'AppTrackingTransparency', method: 'getPluginVersion', label: 'capacitor-app-tracking-transparency' },
  { packageName: '@capgo/capacitor-appinsights', pluginName: 'CapacitorAppInsights', method: 'getPluginVersion', label: 'capacitor-appinsights' },
  { packageName: '@capgo/capacitor-appsflyer', pluginName: 'AppsFlyerPlugin', method: 'getSdkVersion', label: 'capacitor-appsflyer' },
  { packageName: '@capgo/capacitor-audio-recorder', pluginName: 'CapacitorAudioRecorder', method: 'getPluginVersion', label: 'capacitor-audio-recorder' },
  { packageName: '@capgo/capacitor-audio-session', pluginName: 'AudioSession', method: 'getPluginVersion', label: 'capacitor-audio-session' },
  { packageName: '@capgo/capacitor-autofill-save-password', pluginName: 'SavePassword', method: 'getPluginVersion', label: 'capacitor-autofill-save-password' },
  { packageName: '@capgo/capacitor-background-task', pluginName: 'BackgroundTask', method: 'getStatus', label: 'capacitor-background-task' },
  { packageName: '@capgo/capacitor-barometer', pluginName: 'CapacitorBarometer', method: 'getPluginVersion', label: 'capacitor-barometer' },
  { packageName: '@capgo/capacitor-brightness', pluginName: 'CapgoBrightness', method: 'getPluginVersion', label: 'capacitor-brightness' },
  { packageName: '@capgo/capacitor-calendar', pluginName: 'CapacitorCalendar', method: 'checkAllPermissions', label: 'capacitor-calendar' },
  { packageName: '@capgo/capacitor-compass', pluginName: 'CapgoCompass', method: 'getPluginVersion', label: 'capacitor-compass' },
  { packageName: '@capgo/capacitor-crisp', pluginName: 'CapacitorCrisp', method: 'getPluginVersion', label: 'capacitor-crisp' },
  { packageName: '@capgo/capacitor-data-storage-sqlite', pluginName: 'CapgoCapacitorDataStorageSqlite', method: 'getPluginVersion', label: 'capacitor-data-storage-sqlite' },
  { packageName: '@capgo/capacitor-date-picker', pluginName: 'DatePicker', method: 'getPluginVersion', label: 'capacitor-date-picker' },
  { packageName: '@capgo/capacitor-document-scanner', pluginName: 'DocumentScanner', method: 'getPluginVersion', label: 'capacitor-document-scanner' },
  { packageName: '@capgo/capacitor-downloader', pluginName: 'CapacitorDownloader', method: 'getPluginVersion', label: 'capacitor-downloader' },
  { packageName: '@capgo/capacitor-file', pluginName: 'CapacitorFile', method: 'getPluginVersion', label: 'capacitor-file' },
  { packageName: '@capgo/capacitor-file-compressor', pluginName: 'FileCompressor', method: 'getPluginVersion', label: 'capacitor-file-compressor' },
  { packageName: '@capgo/capacitor-file-picker', pluginName: 'CapgoFilePicker', method: 'getPluginVersion', label: 'capacitor-file-picker' },
  { packageName: '@capgo/capacitor-file-sharer', pluginName: 'FileSharer', method: 'getPluginVersion', label: 'capacitor-file-sharer' },
  { packageName: '@capgo/capacitor-flash', pluginName: 'CapacitorFlash', method: 'getPluginVersion', label: 'capacitor-flash' },
  { packageName: '@capgo/capacitor-home-indicator', pluginName: 'HomeIndicator', method: 'getPluginVersion', label: 'capacitor-home-indicator' },
  { packageName: '@capgo/capacitor-in-app-review', pluginName: 'CapgoInAppReview', method: 'getPluginVersion', label: 'capacitor-in-app-review' },
  { packageName: '@capgo/capacitor-install-referrer', pluginName: 'InstallReferrer', method: 'getPluginVersion', label: 'capacitor-install-referrer' },
  { packageName: '@capgo/capacitor-intent-launcher', pluginName: 'IntentLauncher', method: 'getPluginVersion', label: 'capacitor-intent-launcher' },
  { packageName: '@capgo/capacitor-intercom', pluginName: 'CapgoIntercom', method: 'getUnreadConversationCount', label: 'capacitor-intercom' },
  { packageName: '@capgo/capacitor-is-root', pluginName: 'IsRoot', method: 'getPluginVersion', label: 'capacitor-is-root' },
  { packageName: '@capgo/capacitor-jw-player', pluginName: 'JwPlayer', method: 'getPluginVersion', label: 'capacitor-jw-player' },
  { packageName: '@capgo/capacitor-keep-awake', pluginName: 'CapacitorKeepAwake', method: 'getPluginVersion', label: 'capacitor-keep-awake' },
  { packageName: '@capgo/capacitor-launch-navigator', pluginName: 'LaunchNavigator', method: 'getPluginVersion', label: 'capacitor-launch-navigator' },
  { packageName: '@capgo/capacitor-light-sensor', pluginName: 'CapgoLightSensor', method: 'getPluginVersion', label: 'capacitor-light-sensor' },
  { packageName: '@capgo/capacitor-llm', pluginName: 'CapgoLLM', method: 'getPluginVersion', label: 'capacitor-llm' },
  { packageName: '@capgo/capacitor-media-session', pluginName: 'MediaSession', method: 'getPluginVersion', label: 'capacitor-media-session' },
  { packageName: '@capgo/capacitor-mqtt', pluginName: 'MqttBridge', method: 'disconnect', label: 'capacitor-mqtt' },
  { packageName: '@capgo/capacitor-mute', pluginName: 'Mute', method: 'getPluginVersion', label: 'capacitor-mute' },
  { packageName: '@capgo/capacitor-mux-player', pluginName: 'MuxPlayer', method: 'getPluginVersion', label: 'capacitor-mux-player' },
  { packageName: '@capgo/capacitor-native-biometric', pluginName: 'NativeBiometric', method: 'getPluginVersion', label: 'capacitor-native-biometric' },
  { packageName: '@capgo/capacitor-native-navigation', pluginName: 'NativeNavigation', method: 'getPluginVersion', label: 'capacitor-native-navigation' },
  { packageName: '@capgo/capacitor-navigation-bar', pluginName: 'NavigationBar', method: 'getPluginVersion', label: 'capacitor-navigation-bar' },
  { packageName: '@capgo/capacitor-nfc', pluginName: 'CapacitorNfc', method: 'getPluginVersion', label: 'capacitor-nfc' },
  { packageName: '@capgo/capacitor-pdf-generator', pluginName: 'PdfGenerator', method: 'getPluginVersion', label: 'capacitor-pdf-generator' },
  { packageName: '@capgo/capacitor-pedometer', pluginName: 'CapacitorPedometer', method: 'getPluginVersion', label: 'capacitor-pedometer' },
  { packageName: '@capgo/capacitor-persistent-account', pluginName: 'CapacitorPersistentAccount', method: 'getPluginVersion', label: 'capacitor-persistent-account' },
  {
    packageName: '@capgo/capacitor-pretty-toast',
    pluginName: 'PrettyToast',
    method: 'showCurrentToast',
    label: 'capacitor-pretty-toast',
    option: { id: 'sandbox-pretty-toast', title: 'Capgo plugin sandbox', message: 'PrettyToast bridge is available', duration: 2000 },
  },
  { packageName: '@capgo/capacitor-printer', pluginName: 'Printer', method: 'getPluginVersion', label: 'capacitor-printer' },
  { packageName: '@capgo/capacitor-privacy-screen', pluginName: 'PrivacyScreen', method: 'getPluginVersion', label: 'capacitor-privacy-screen' },
  { packageName: '@capgo/capacitor-proximity', pluginName: 'CapacitorProximity', method: 'getPluginVersion', label: 'capacitor-proximity' },
  { packageName: '@capgo/capacitor-recaptcha', pluginName: 'Recaptcha', method: 'getPluginVersion', label: 'capacitor-recaptcha' },
  { packageName: '@capgo/capacitor-rudderstack', pluginName: 'RudderStack', method: 'getPluginVersion', label: 'capacitor-rudderstack' },
  { packageName: '@capgo/capacitor-screen-orientation', pluginName: 'CapacitorScreenOrientation', method: 'getPluginVersion', label: 'capacitor-screen-orientation' },
  { packageName: '@capgo/capacitor-screen-recorder', pluginName: 'ScreenRecorder', method: 'getPluginVersion', label: 'capacitor-screen-recorder' },
  { packageName: '@capgo/capacitor-shake', pluginName: 'CapacitorShake', method: 'getPluginVersion', label: 'capacitor-shake' },
  { packageName: '@capgo/capacitor-sim', pluginName: 'Sim', method: 'getPluginVersion', label: 'capacitor-sim' },
  { packageName: '@capgo/capacitor-speech-recognition', pluginName: 'SpeechRecognition', method: 'getPluginVersion', label: 'capacitor-speech-recognition' },
  { packageName: '@capgo/capacitor-speech-synthesis', pluginName: 'SpeechSynthesis', method: 'getPluginVersion', label: 'capacitor-speech-synthesis' },
  { packageName: '@capgo/capacitor-textinteraction', pluginName: 'TextInteraction', method: 'getPluginVersion', label: 'capacitor-textinteraction' },
  { packageName: '@capgo/capacitor-updater', pluginName: 'CapacitorUpdater', method: 'getPluginVersion', label: 'capacitor-updater' },
  { packageName: '@capgo/capacitor-uploader', pluginName: 'Uploader', method: 'getPluginVersion', label: 'capacitor-uploader' },
  { packageName: '@capgo/capacitor-video-player', pluginName: 'VideoPlayer', method: 'getPluginVersion', label: 'capacitor-video-player' },
  { packageName: '@capgo/capacitor-video-thumbnails', pluginName: 'CapgoVideoThumbnails', method: 'getPluginVersion', label: 'capacitor-video-thumbnails' },
  { packageName: '@capgo/capacitor-volume-buttons', pluginName: 'VolumeButtons', method: 'getPluginVersion', label: 'capacitor-volume-buttons' },
  { packageName: '@capgo/capacitor-webview-crash', pluginName: 'WebViewCrash', method: 'getPendingCrashInfo', label: 'capacitor-webview-crash' },
  { packageName: '@capgo/capacitor-webview-guardian', pluginName: 'WebviewGuardian', method: 'getState', label: 'capacitor-webview-guardian' },
  { packageName: '@capgo/capacitor-wifi', pluginName: 'CapacitorWifi', method: 'getPluginVersion', label: 'capacitor-wifi' },
  { packageName: '@capgo/capacitor-youtube-player', pluginName: 'YoutubePlayer', method: 'getPluginVersion', label: 'capacitor-youtube-player' },
  { packageName: '@capgo/capacitor-zebra-datawedge', pluginName: 'ZebraDataWedge', method: 'getPluginVersion', label: 'capacitor-zebra-datawedge' },
  { packageName: '@capgo/capacitor-zip', pluginName: 'CapacitorZip', method: 'getPluginVersion', label: 'capacitor-zip' },
  { packageName: '@capgo/capacitor-inappbrowser', pluginName: 'InAppBrowser', method: 'getPluginVersion', label: 'capacitor-inappbrowser' },
  { packageName: '@capgo/capacitor-native-audio', pluginName: 'NativeAudio', method: 'getPluginVersion', label: 'capacitor-native-audio' },
  { packageName: '@capgo/capacitor-native-market', pluginName: 'NativeMarket', method: 'getPluginVersion', label: 'capacitor-native-market' },
  { packageName: '@capgo/capacitor-nativegeocoder', pluginName: 'NativeGeocoder', method: 'getPluginVersion', label: 'capacitor-nativegeocoder' },
  { packageName: '@capgo/capacitor-ricoh360', pluginName: 'Ricoh360Camera', method: 'getPluginVersion', label: 'capacitor-ricoh360' },
  { packageName: '@revenuecat/purchases-capacitor', pluginName: 'Purchases', method: 'isConfigured', label: 'purchases-capacitor' },
]

const bundledJsOnlyPlugins: PluginNote[] = [
  { packageName: '@capgo/capacitor-sheets', reason: 'Bundled for web UI testing; no native Capacitor bridge is registered.' },
  { packageName: '@capgo/capacitor-transitions', reason: 'Bundled for web transition testing; no native Capacitor bridge is registered.' },
]

const skippedPlugins: PluginNote[] = [
  { packageName: '@capgo/background-geolocation', reason: 'Requires background location modes and platform permission setup.' },
  { packageName: '@capgo/capacitor-admob', reason: 'Requires a Google Mobile Ads application ID in native config.' },
  { packageName: '@capgo/capacitor-alarm', reason: 'Current iOS AlarmKit bridge does not compile against the installed iOS 26.4 SDK.' },
  { packageName: '@capgo/capacitor-auto', reason: 'Requires CarPlay or Android Auto native app configuration.' },
  { packageName: '@capgo/capacitor-bluetooth-low-energy', reason: 'Requires Bluetooth usage text and native permission setup.' },
  { packageName: '@capgo/capacitor-contacts', reason: 'Requires contacts usage text.' },
  { packageName: '@capgo/capacitor-contentsquare', reason: 'Requires iOS URL scheme setup.' },
  { packageName: '@capgo/capacitor-disqo', reason: 'Requires DISQO vendor account configuration before runtime use.' },
  { packageName: '@capgo/capacitor-env', reason: 'Configured from native build settings, not runtime JavaScript.' },
  { packageName: '@capgo/capacitor-fast-sql', reason: 'Requires native SQLCipher setup; the simulator build cannot resolve sqlite3_key.' },
  { packageName: '@capgo/capacitor-ffmpeg', reason: 'Requires native FFmpeg linkage; the app build cannot resolve FFmpeg symbols without it.' },
  { packageName: '@capgo/capacitor-facebook-analytics', reason: 'Requires Meta values in Info.plist and AndroidManifest.xml.' },
  { packageName: '@capgo/capacitor-firebase/*', reason: 'Requires Firebase native configuration files.' },
  { packageName: '@capgo/capacitor-gtm', reason: 'Requires native Google Tag Manager container setup.' },
  { packageName: '@capgo/capacitor-health', reason: 'Requires HealthKit and Google Fit native setup.' },
  { packageName: '@capgo/capacitor-ibeacon', reason: 'Requires beacon background modes and native permission setup.' },
  { packageName: '@capgo/capacitor-incoming-call-kit', reason: 'Requires native notification/call surfaces beyond JS configuration.' },
  { packageName: '@capgo/capacitor-intune', reason: 'Requires Microsoft Intune, MSAL, URL scheme, and entitlement setup.' },
  { packageName: '@capgo/capacitor-live-activities', reason: 'Requires ActivityKit/widget native setup and is not published as a runtime package.' },
  { packageName: '@capgo/capacitor-live-reload', reason: 'Development-only server configuration, not a sandbox runtime plugin.' },
  { packageName: '@capgo/native-purchases', reason: 'Requires store billing platform setup and Android billing manifest changes.' },
  { packageName: '@capgo/capacitor-passkey', reason: 'Requires associated domains and Digital Asset Links setup.' },
  { packageName: '@capgo/capacitor-patch', reason: 'Build-time patch package, not a runtime mobile plugin.' },
  { packageName: '@capgo/capacitor-pay', reason: 'Requires Apple Pay merchant entitlements and Google Pay business setup.' },
  { packageName: '@capgo/capacitor-persona', reason: 'Requires vendor identity verification app setup.' },
  { packageName: '@capgo/capacitor-plus', reason: 'Capacitor runtime replacement package, not a sandbox plugin.' },
  { packageName: '@capgo/capacitor-realtimekit', reason: 'Requires Bluetooth/background native permissions for meetings.' },
  { packageName: '@capgo/capacitor-share-target', reason: 'Requires native share target intent and extension setup.' },
  { packageName: '@capgo/capacitor-social-login', reason: 'Requires provider URL schemes and OAuth native setup.' },
  { packageName: '@capgo/capacitor-ssl-pinning', reason: 'Requires bundled certificates and Capacitor HTTP configuration.' },
  { packageName: '@capgo/capacitor-stream-call', reason: 'Requires Stream API keys in native files and Android application wiring.' },
  { packageName: '@capgo/capacitor-supabase', reason: 'Requires native auth callback setup.' },
  { packageName: '@capgo/capacitor-twilio-video', reason: 'Catalog entry is not published as an installable runtime package.' },
  { packageName: '@capgo/capacitor-twilio-voice', reason: 'Requires PushKit, Firebase, VoIP certificates, and native manifest setup.' },
  { packageName: '@capgo/capacitor-watch', reason: 'Requires watch app/native companion setup.' },
  { packageName: '@capgo/capacitor-webview-version-checker', reason: 'Published package sync hook references a missing script.' },
  { packageName: '@capgo/capacitor-wechat', reason: 'Requires WeChat native SDK app registration and URL schemes.' },
  { packageName: '@capgo/capacitor-widget-kit', reason: 'Requires iOS 16 while the app target still supports iOS 15.' },
  { packageName: '@capgo/electron-updater', reason: 'Electron package, not a mobile app plugin.' },
  { packageName: '@capgo/capacitor+*', reason: 'Capacitor runtime replacement packages, not runtime mobile plugins.' },
]

function pluginKey(m: PluginTest) {
  return `${m.pluginName}.${m.method}`
}

function getPlugin(pluginName: string) {
  const cachedPlugin = pluginCache.get(pluginName)
  if (cachedPlugin)
    return cachedPlugin

  const plugin = registerPlugin<NativePlugin>(pluginName)
  pluginCache.set(pluginName, plugin)
  return plugin
}

function formatPayload(payload: unknown) {
  if (payload === undefined)
    return 'ok'
  if (typeof payload === 'string')
    return payload
  try {
    return JSON.stringify(payload)
  }
  catch {
    return String(payload)
  }
}

async function runMethod(m: PluginTest) {
  console.log('runMethod', m)
  const plugin = getPlugin(m.pluginName)
  const runner = plugin[m.method]
  if (typeof runner !== 'function') {
    const error = `${m.pluginName}.${m.method} is not available`
    lastResults.value = { ...lastResults.value, [pluginKey(m)]: error }
    toast.error(error)
    return
  }

  try {
    const res = m.option ? await runner(m.option) : await runner()
    const result = formatPayload(res)
    console.log('resMethod', m, res)
    lastResults.value = { ...lastResults.value, [pluginKey(m)]: result }
    toast.success(`${m.label}: ${result}`)
  }
  catch (err) {
    const result = err instanceof Error ? err.message : String(err)
    console.log('errMethod', m, err)
    lastResults.value = { ...lastResults.value, [pluginKey(m)]: result }
    toast.error(`${m.label}: ${result}`)
  }
}
displayStore.NavTitle = `${t('module-heading')} ${t('tests')}`
displayStore.defaultBack = '/apps'
// console.log('modules', modules.value)
</script>

<template>
  <div>
    <div class="flex overflow-y-auto flex-col bg-white shadow-sm md:mx-auto md:mt-5 md:w-2/3 md:rounded-xl md:border border-slate-200 dark:border-white/10 dark:bg-slate-800/60">
      <dl class="divide-y divide-slate-200 dark:divide-slate-500">
        <InfoRow :label="t('available-in-the-san')" />
        <InfoRow :label="t('plugin-sandbox-native-bridge-tests')" :value="String(pluginTests.length)" />
        <InfoRow v-for="module in pluginTests" :key="pluginKey(module)" :value="lastResults[pluginKey(module)] ?? module.packageName" :label="`${module.label}@${module.method}`" :is-link="true" @click="runMethod(module)">
          <button type="button" class="d-btn d-btn-ghost d-btn-sm ml-auto w-7 h-7 p-0">
            <IconNext />
          </button>
        </InfoRow>
        <InfoRow :label="t('plugin-sandbox-js-only-packages')" :value="String(bundledJsOnlyPlugins.length)" />
        <InfoRow v-for="module in bundledJsOnlyPlugins" :key="module.packageName" :value="module.reason" :label="module.packageName" />
        <InfoRow :label="t('plugin-sandbox-skipped-native-setup')" :value="String(skippedPlugins.length)" />
        <InfoRow v-for="module in skippedPlugins" :key="module.packageName" :value="module.reason" :label="module.packageName" />
      </dl>
    </div>
  </div>
</template>
