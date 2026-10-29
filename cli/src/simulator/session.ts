import { stdout } from 'node:process'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, resolveCapgoApiHosts } from '../utils'

export interface SimulatorCommandOptions {
  apikey?: string
  apiHost?: string
  platform?: string
  name?: string
  json?: boolean
}

export function simulatorApiRequest(host: string, command: 'start' | 'stop' | 'get', input: {
  appId: string
  platform?: string
  name?: string
  id?: string
}) {
  const base = host.replace(/\/$/, '')
  if (command === 'start') {
    return {
      method: 'POST' as const,
      url: `${base}/build/simulator`,
      body: { app_id: input.appId, platform: input.platform, name: input.name },
    }
  }
  if (!input.id)
    throw new CliUserError('session id is required')
  if (command === 'stop') {
    return {
      method: 'POST' as const,
      url: `${base}/build/simulator/${input.id}/stop`,
      body: { app_id: input.appId },
    }
  }
  return {
    method: 'GET' as const,
    url: `${base}/build/simulator/${input.id}?app_id=${encodeURIComponent(input.appId)}`,
    body: undefined,
  }
}

async function callSimulator(command: 'start' | 'stop' | 'get', appId: string, sessionId: string | undefined, options: SimulatorCommandOptions) {
  const platform = options.platform ?? 'ios'
  if (platform !== 'ios' && platform !== 'android')
    throw new CliUserError('--platform must be ios or android')
  const apikey = options.apikey || findSavedKey()
  if (!apikey)
    throw new CliUserError('Missing API key. Pass --apikey or run capgo login.')
  const { apiHost } = await resolveCapgoApiHosts(options.apiHost)
  const request = simulatorApiRequest(apiHost, command, { appId, platform, name: options.name, id: sessionId })
  const response = await fetch(request.url, {
    method: request.method,
    headers: buildCliRequestHeaders({
      'Content-Type': 'application/json',
      'authorization': apikey,
    }),
    body: request.body ? JSON.stringify(request.body) : undefined,
  })
  const text = await response.text()
  if (!response.ok)
    throw new CliUserError(text || `Simulator request failed (${response.status})`)
  const payload = text ? JSON.parse(text) as { data?: { id?: string, url?: string, status?: string, kind?: string } } : {}
  if (options.json)
    stdout.write(`${JSON.stringify(payload)}\n`)
  else if (payload.data?.url)
    stdout.write(`${payload.data.url}\n`)
  else
    stdout.write(`${payload.data?.status ?? 'ok'}\n`)
}

export function startSimulatorCommand(appId: string | undefined, options: SimulatorCommandOptions) {
  if (!appId)
    throw new CliUserError('app id is required')
  return callSimulator('start', appId, undefined, options)
}

export function stopSimulatorCommand(sessionId: string | undefined, appId: string | undefined, options: SimulatorCommandOptions) {
  if (!sessionId || !appId)
    throw new CliUserError('session id and app id are required')
  return callSimulator('stop', appId, sessionId, options)
}

export function getSimulatorCommand(sessionId: string | undefined, appId: string | undefined, options: SimulatorCommandOptions) {
  if (!sessionId || !appId)
    throw new CliUserError('session id and app id are required')
  return callSimulator('get', appId, sessionId, options)
}
