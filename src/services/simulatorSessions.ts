import { reactive } from 'vue'

export interface RunningSimulator {
  id: string
  url: string
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
