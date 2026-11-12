// Live build page state: folds builder log-stream messages (WebSocket or the
// dev demo) into a view model. Plain TS so it can be unit tested.

export type BuildPlatform = 'ios' | 'android'
export type BuildOutcome = 'success' | 'failure'
type StepStatus = 'running' | 'succeeded' | 'failed'
type RowState = 'done' | 'running' | 'failed' | 'pending'

interface LiveStep {
  action: string
  status: StepStatus
  startedAt?: number
  durationMs?: number
}

export interface BuildLiveState {
  lastId: number
  status: string | null
  statusMessage: string | null
  steps: LiveStep[]
  downloadUrl: string | null
}

interface TimelineRow {
  key: string
  state: RowState
  startedAt?: number
  durationMs?: number
}

const SUCCESS_STATUSES = new Set(['succeeded', 'released'])
const FAILURE_STATUSES = new Set(['failed', 'expired', 'cancelled', 'canceled'])
const STEP_STATUS: Record<string, StepStatus> = { started: 'running', succeeded: 'succeeded', failed: 'failed' }

// Main fastlane actions we expect for a first build, shown greyed until they start.
const PLATFORM_MILESTONES: Record<BuildPlatform, string[]> = {
  android: ['project_bundle_download', 'android_sdk_setup', 'android_signing_prepare', 'android_aab_build', 'google_play_upload'],
  ios: ['project_bundle_download', 'ios_dependencies_install', 'ios_signing_setup', 'ios_archive_build', 'testflight_upload'],
}

// Friendly copy for the main actions; anything else is humanized from its id.
// Keys are literal so the i18n context generator can find them.
const STEP_COPY: Record<string, [label: string, why: string]> = {
  upload: ['build-live-step-upload', 'build-live-step-upload-why'],
  machine: ['build-live-step-machine', 'build-live-step-machine-why'],
  build: ['build-live-step-build', 'build-live-step-build-why'],
  project_bundle_download: ['build-live-step-download', 'build-live-step-download-why'],
  build_secrets_download: ['build-live-step-credentials', 'build-live-step-credentials-why'],
  build_cache_restore: ['build-live-step-cache', 'build-live-step-cache-why'],
  android_sdk_setup: ['build-live-step-android-sdk', 'build-live-step-android-sdk-why'],
  android_signing_prepare: ['build-live-step-signing', 'build-live-step-signing-why'],
  android_aab_build: ['build-live-step-android-build', 'build-live-step-android-build-why'],
  android_apk_build: ['build-live-step-android-build', 'build-live-step-android-build-why'],
  google_play_upload: ['build-live-step-play-upload', 'build-live-step-play-upload-why'],
  ios_dependencies_install: ['build-live-step-ios-deps', 'build-live-step-ios-deps-why'],
  ios_signing_setup: ['build-live-step-signing', 'build-live-step-signing-why'],
  ios_archive_build: ['build-live-step-ios-build', 'build-live-step-ios-build-why'],
  testflight_upload: ['build-live-step-testflight', 'build-live-step-testflight-why'],
  aab_artifact_upload: ['build-live-step-artifact', 'build-live-step-artifact-why'],
  apk_artifact_upload: ['build-live-step-artifact', 'build-live-step-artifact-why'],
  ipa_artifact_upload: ['build-live-step-artifact', 'build-live-step-artifact-why'],
}

export function stepCopy(action: string): { labelKey: string | null, whyKey: string | null, fallback: string } {
  const humanized = action.replaceAll('_', ' ')
  const fallback = humanized.charAt(0).toUpperCase() + humanized.slice(1)
  const copy = STEP_COPY[action]
  return { labelKey: copy?.[0] ?? null, whyKey: copy?.[1] ?? null, fallback }
}

export function createBuildLiveState(): BuildLiveState {
  return { lastId: 0, status: null, statusMessage: null, steps: [], downloadUrl: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTerminal(status: string | null | undefined) {
  return !!status && (SUCCESS_STATUSES.has(status) || FAILURE_STATUSES.has(status))
}

export function resolveBuildOutcome(streamStatus: string | null | undefined, dbStatus: string | null | undefined): BuildOutcome | null {
  // The stream reports the end first; the row can lag when the CLI is closed.
  const status = isTerminal(streamStatus) ? streamStatus : dbStatus
  if (status && SUCCESS_STATUSES.has(status))
    return 'success'
  if (status && FAILURE_STATUSES.has(status))
    return 'failure'
  return null
}

function applyStep(state: BuildLiveState, data: Record<string, unknown>): BuildLiveState {
  const status = typeof data.status === 'string' ? STEP_STATUS[data.status] : undefined
  if (typeof data.action !== 'string' || !data.action || !status)
    return state
  const ts = typeof data.ts === 'number' ? data.ts : undefined
  const durationMs = typeof data.duration_ms === 'number' ? data.duration_ms : undefined
  const existing = state.steps.find(s => s.action === data.action)
  if (!existing) {
    const added: LiveStep = { action: data.action, status, startedAt: status === 'running' ? ts : undefined, durationMs }
    return { ...state, steps: [...state.steps, added] }
  }
  const updated: LiveStep = status === 'running'
    ? { action: existing.action, status, startedAt: ts ?? existing.startedAt }
    : { ...existing, status, durationMs: durationMs ?? existing.durationMs }
  return { ...state, steps: state.steps.map(s => s === existing ? updated : s) }
}

function applyEntry(state: BuildLiveState, entry: Record<string, unknown>): BuildLiveState {
  if (entry.type === 'status' && typeof entry.status === 'string') {
    const statusMessage = typeof entry.message === 'string' ? entry.message : state.statusMessage
    return { ...state, status: entry.status.toLowerCase(), statusMessage }
  }
  if (entry.type === 'custom_msg' && isRecord(entry.data)) {
    if (entry.kind === 'step')
      return applyStep(state, entry.data)
    const url = entry.data.url
    if (entry.kind === 'qr_download_link' && typeof url === 'string' && /^https?:\/\//i.test(url))
      return { ...state, downloadUrl: url }
  }
  return state
}

export function applyBuildStreamMessage(state: BuildLiveState, raw: unknown): BuildLiveState {
  if (!isRecord(raw))
    return state
  if (raw.type === 'batch_messages' && Array.isArray(raw.messages))
    return raw.messages.reduce((acc: BuildLiveState, message: unknown) => applyBuildStreamMessage(acc, message), state)
  const id = typeof raw.id === 'number' ? raw.id : null
  // Reconnects replay from the last id we reported: skip anything already applied.
  if (id !== null && id <= state.lastId)
    return state
  const next = applyEntry(state, raw)
  return id === null ? next : { ...next, lastId: id }
}

function machineState(uploading: boolean, onMachine: boolean): RowState {
  if (uploading)
    return 'pending'
  return onMachine ? 'done' : 'running'
}

function stepRows(live: BuildLiveState, platform: BuildPlatform, running: boolean): TimelineRow[] {
  const rows: TimelineRow[] = live.steps.map(s => ({
    key: s.action,
    state: s.status === 'succeeded' ? 'done' : s.status,
    startedAt: s.startedAt,
    durationMs: s.durationMs,
  }))
  // Upcoming milestones only make sense while the build still runs.
  if (running) {
    const seen = new Set(live.steps.map(s => s.action))
    for (const action of PLATFORM_MILESTONES[platform].filter(a => !seen.has(a)))
      rows.push({ key: action, state: 'pending' })
  }
  return rows
}

function applyOutcome(rows: TimelineRow[], outcome: BuildOutcome | null) {
  if (outcome === 'success') {
    for (const row of rows)
      row.state = 'done'
    return
  }
  if (outcome !== 'failure' || rows.some(r => r.state === 'failed'))
    return
  const culprit = rows.find(r => r.state === 'running') ?? rows.find(r => r.state === 'pending')
  if (culprit)
    culprit.state = 'failed'
}

function currentIndex(rows: TimelineRow[], outcome: BuildOutcome | null): number {
  const failedIndex = rows.findIndex(r => r.state === 'failed')
  if (failedIndex !== -1)
    return failedIndex
  const runningIndex = rows.findIndex(r => r.state === 'running')
  if (runningIndex !== -1)
    return runningIndex
  if (outcome)
    return rows.length - 1
  // Between two steps nothing runs yet: point at the next one.
  const nextIndex = rows.findIndex(r => r.state === 'pending')
  return nextIndex === -1 ? rows.length - 1 : nextIndex
}

export function buildTimeline(input: {
  live: BuildLiveState
  dbStatus: string | null | undefined
  machineStarted: boolean
  platform: BuildPlatform
}): { rows: TimelineRow[], current: number, progress: number } {
  const { live, dbStatus, machineStarted, platform } = input
  const outcome = resolveBuildOutcome(live.status, dbStatus)
  const hasSteps = live.steps.length > 0
  const uploading = dbStatus === 'pending' && !hasSteps
  const onMachine = machineStarted || hasSteps
  const rows: TimelineRow[] = [
    { key: 'upload', state: uploading ? 'running' : 'done' },
    { key: 'machine', state: machineState(uploading, onMachine) },
    ...(hasSteps ? stepRows(live, platform, !outcome) : [{ key: 'build', state: onMachine ? 'running' : 'pending' } as TimelineRow]),
  ]
  applyOutcome(rows, outcome)
  const progress = rows.filter(r => r.state === 'done').length / rows.length
  return { rows, current: currentIndex(rows, outcome), progress }
}
