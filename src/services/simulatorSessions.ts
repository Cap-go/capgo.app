import { reactive, ref } from 'vue'

export interface RunningSimulator {
  id: string
  url: string
}

// False once the API says this server has no simulator host: start buttons would only fail.
// Null until known (older API): the buttons stay.
export const simulatorConfigured = ref<boolean | null>(null)

// A start refused for a missing simulator host also settles it, before any list answered.
export function noteSimulatorStartError(payload: { error?: string } | undefined) {
  if (payload?.error === 'simulator_not_configured')
    simulatorConfigured.value = false
}

const sessionsByApp = reactive<Record<string, RunningSimulator[]>>({})
let sessionEpoch = 0

export function simulatorEpoch() {
  return sessionEpoch
}

export function clearSimulatorSessions() {
  sessionEpoch += 1
  for (const appId of Object.keys(sessionsByApp))
    delete sessionsByApp[appId]
}

export function runningSimulators(appId: string) {
  if (!sessionsByApp[appId])
    sessionsByApp[appId] = []
  return sessionsByApp[appId]
}

export function rememberSimulator(appId: string, session: RunningSimulator, epoch = sessionEpoch) {
  if (epoch !== sessionEpoch)
    return
  const sessions = runningSimulators(appId)
  if (sessions.some(item => item.id === session.id))
    return
  sessions.push(session)
}

export function rememberedSessionStillRunning(httpStatus: number, sessionStatus?: string) {
  if (httpStatus === 400 || httpStatus === 404)
    return false
  if (httpStatus < 200 || httpStatus >= 300)
    return true
  return sessionStatus === 'in-progress'
}

export async function sessionRemainsAfterLookup(lookup: () => Promise<{ httpStatus: number, sessionStatus?: string }>) {
  try {
    const result = await lookup()
    return rememberedSessionStillRunning(result.httpStatus, result.sessionStatus)
  }
  catch {
    return true
  }
}

export function forgetSimulator(appId: string, id: string) {
  const sessions = runningSimulators(appId)
  const index = sessions.findIndex(item => item.id === id)
  if (index >= 0)
    sessions.splice(index, 1)
}

// One row of GET /private/simulator: a recent session and the build time it counted.
export interface SimulatorSummary {
  id: string
  platform: 'ios' | 'android'
  status: string
  url: string | null
  started_at: string | null
  finished_at: string | null
  // How long it ran, and what that counted against the plan (iOS counts double).
  build_time_seconds: number | null
  billable_seconds: number | null
}

// The server knows about sessions started in other tabs, and about devices that stopped by themselves.
// The list can be up to a minute old: a session this tab just stopped is never shown running again,
// and one it just started, still listed as starting, stays.
export function applySimulatorList(appId: string, list: SimulatorSummary[], epoch = sessionEpoch, stopped: ReadonlySet<string> = new Set()) {
  if (epoch !== sessionEpoch)
    return
  for (const item of list) {
    if (stopped.has(item.id) || item.status === 'stopped' || item.status === 'errored')
      forgetSimulator(appId, item.id)
    else if (item.status === 'in-progress')
      rememberSimulator(appId, { id: item.id, url: item.url ?? '' }, epoch)
  }
}

export function formatSimulatorDuration(seconds: number | null | undefined) {
  if (seconds == null)
    return ''
  const total = Math.max(0, Math.round(seconds))
  if (total < 60)
    return `${total}s`
  const minutes = Math.round(total / 60)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}
