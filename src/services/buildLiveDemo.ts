// Dev-only scripted build for reviewing the live build page without a builder
// (`?buildDemo=success|store|failure`). Only loaded through a dynamic import
// behind `import.meta.env.DEV`, so it never ships to production.
import type { BuildPlatform } from '~/services/buildLiveStream'

type DemoMode = 'success' | 'store' | 'failure'
interface DemoRow { status: string, started_at: string | null }

const STEPS: Record<BuildPlatform, string[]> = {
  android: [
    'project_bundle_download',
    'build_cache_restore',
    'android_sdk_setup',
    'android_signing_prepare',
    'android_aab_build',
    'google_play_upload',
  ],
  ios: [
    'project_bundle_download',
    'ios_dependencies_install',
    'ios_signing_setup',
    'ios_archive_build',
    'testflight_upload',
  ],
}

const FAILURE_MESSAGE: Record<BuildPlatform, string> = {
  android: 'e: Unresolved reference: BarcodeScanner (MainActivity.kt:14)',
  ios: 'error: No such module \'BarcodeScanner\' (AppDelegate.swift:3)',
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

  const steps = STEPS[platform]
  const failAt = demoMode === 'failure' ? steps.length - 2 : -1
  for (const [index, action] of steps.entries()) {
    const started = { at: 0 }
    later(600, () => {
      started.at = Date.now()
      step(action, 'started')
    })
    if (index === failAt) {
      later(2000, () => {
        step(action, 'failed', Date.now() - started.at)
        send({ type: 'status', status: 'failed', message: FAILURE_MESSAGE[platform] })
      })
      break
    }
    later(2000, () => step(action, 'succeeded', Date.now() - started.at))
  }
  if (demoMode !== 'failure') {
    if (demoMode === 'success')
      later(300, () => send({ type: 'custom_msg', kind: 'qr_download_link', data: { url: 'https://example.com/demo-build.apk' } }))
    later(300, () => send({ type: 'status', status: 'succeeded' }))
  }
  return () => timers.forEach(clearTimeout)
}
