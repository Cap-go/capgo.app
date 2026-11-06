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

export function rememberSimulator(appId: string, session: RunningSimulator) {
  const sessions = runningSimulators(appId)
  if (sessions.some(item => item.id === session.id))
    return
  sessions.push(session)
}

export function forgetSimulator(appId: string, id: string) {
  const sessions = runningSimulators(appId)
  const index = sessions.findIndex(item => item.id === id)
  if (index >= 0)
    sessions.splice(index, 1)
}
