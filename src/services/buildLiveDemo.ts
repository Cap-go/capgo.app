// Dev-only scripted build for reviewing the live build page without a builder
// (`?buildDemo=success|store|failure`). Only loaded through a dynamic import
// behind `import.meta.env.DEV`, so it never ships to production.
import type { BuildPlatform } from '~/services/buildLiveStream'

type DemoMode = 'success' | 'store' | 'failure'
interface DemoRow { status: string, started_at: string | null }

const STEPS: Record<BuildPlatform, [action: string, logs: string[]][]> = {
  android: [
    ['project_bundle_download', ['Downloading project archive (12.4 MB)', 'Extracted 1 284 files']],
    ['build_cache_restore', ['No cache yet for this app: first build']],
    ['android_sdk_setup', ['Installing platforms;android-35', 'Installing build-tools;35.0.0']],
    ['android_signing_prepare', ['Keystore loaded · alias release']],
    ['android_aab_build', ['> Task :app:preBuild', '> Task :capacitor-android:compileReleaseJavaWithJavac', '> Task :app:mergeReleaseResources', '> Task :app:minifyReleaseWithR8', '> Task :app:bundleRelease', 'BUILD SUCCESSFUL in 3m 32s']],
    ['google_play_upload', ['Uploading app-release.aab to the internal track', 'Upload complete']],
  ],
  ios: [
    ['project_bundle_download', ['Downloading project archive (18.1 MB)', 'Extracted 2 031 files']],
    ['ios_dependencies_install', ['$ pod install', 'Pod installation complete! 14 pods installed.']],
    ['ios_signing_setup', ['Certificate imported into a temporary keychain', 'Provisioning profile installed']],
    ['ios_archive_build', ['▸ Compiling AppDelegate.swift', '▸ Linking App', '▸ Signing App.app', '** ARCHIVE SUCCEEDED **']],
    ['testflight_upload', ['Uploading App.ipa to App Store Connect', 'Upload complete']],
  ],
}

const SETUP_LOGS = ['▸ Preparing the build machine…', '▸ Starting the build…']

const FAILURE_LOGS: Record<BuildPlatform, string[]> = {
  android: ['e: Unresolved reference: BarcodeScanner (MainActivity.kt:14)', 'FAILURE: Build failed with an exception.'],
  ios: ['error: No such module \'BarcodeScanner\' (AppDelegate.swift:3)', '** ARCHIVE FAILED **'],
}

export function playBuildDemo(
  mode: string,
  platform: BuildPlatform,
  onMessage: (message: unknown) => void,
  onRow: (row: DemoRow) => void,
): () => void {
  const demoMode: DemoMode = mode === 'failure' || mode === 'store' ? mode : 'success'
  const timers: ReturnType<typeof setTimeout>[] = []
  let at = 0
  let id = 0
  const later = (delay: number, run: () => void) => {
    at += delay
    timers.push(setTimeout(run, at))
  }
  const send = (message: Record<string, unknown>) => onMessage({ ...message, id: ++id })
  const step = (action: string, status: string, durationMs?: number) =>
    send({ type: 'custom_msg', kind: 'step', data: { action, status, ts: Date.now(), ...(durationMs ? { duration_ms: durationMs } : {}) } })

  onRow({ status: 'pending', started_at: null })
  later(1500, () => onRow({ status: 'running', started_at: null }))
  later(2500, () => onRow({ status: 'running', started_at: new Date().toISOString() }))
  // Untagged lines (before the first step) land under the build machine row.
  for (const line of SETUP_LOGS)
    later(300, () => send({ type: 'log', message: line }))

  const steps = STEPS[platform]
  const failAt = demoMode === 'failure' ? steps.length - 2 : -1
  for (const [index, [action, logs]] of steps.entries()) {
    const started = { at: 0 }
    later(600, () => {
      started.at = Date.now()
      step(action, 'started')
    })
    for (const line of index === failAt ? [...logs.slice(0, 2), ...FAILURE_LOGS[platform]] : logs)
      later(700, () => send({ type: 'log', message: line, step: action }))
    if (index === failAt) {
      later(500, () => {
        step(action, 'failed', Date.now() - started.at)
        send({ type: 'status', status: 'failed', message: FAILURE_LOGS[platform][0] })
      })
      break
    }
    later(500, () => step(action, 'succeeded', Date.now() - started.at))
  }
  if (demoMode !== 'failure') {
    if (demoMode === 'success')
      later(300, () => send({ type: 'custom_msg', kind: 'qr_download_link', data: { url: 'https://example.com/demo-build.apk' } }))
    later(300, () => send({ type: 'status', status: 'succeeded' }))
  }
  return () => timers.forEach(clearTimeout)
}
