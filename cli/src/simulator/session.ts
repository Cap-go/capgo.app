import { stdout } from 'node:process'
import { log } from '@clack/prompts'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, resolveCapgoApiHosts } from '../utils'

function fail(message: string): never {
  log.error(message)
  throw new CliUserError(message)
}

function simulatorErrorText(text: string, status: number) {
  if (!text)
    return `Simulator request failed (${status})`
  try {
    const body = JSON.parse(text) as { message?: string, error?: string }
    if (body.message)
      return body.message
    if (body.error)
      return body.error
  }
  catch {
    // The body is already plain text.
  }
  return text
}

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
    fail('session id is required')
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
    fail('--platform must be ios or android')
  const apikey = options.apikey || findSavedKey()
  if (!apikey)
    fail('Missing API key. Pass --apikey or run capgo login.')
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
    fail(simulatorErrorText(text, response.status))
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
    fail('app id is required')
  return callSimulator('start', appId, undefined, options)
}

export function stopSimulatorCommand(sessionId: string | undefined, appId: string | undefined, options: SimulatorCommandOptions) {
  if (!sessionId || !appId)
    fail('session id and app id are required')
  return callSimulator('stop', appId, sessionId, options)
}

export function getSimulatorCommand(sessionId: string | undefined, appId: string | undefined, options: SimulatorCommandOptions) {
  if (!sessionId || !appId)
    fail('session id and app id are required')
  return callSimulator('get', appId, sessionId, options)
}
