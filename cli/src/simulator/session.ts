import { closeSync, constants, lstatSync, openSync, writeSync } from 'node:fs'
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
  buildJobId?: string
  deviceCommand?: string
  x?: number
  y?: number
  bundleId?: string
}

export interface SimulatorPayload {
  data?: {
    id?: string
    url?: string
    status?: string
    kind?: string
    remoteConfig?: unknown
    image_base64?: string
    image_media_type?: string
    command?: string
    result?: unknown
  }
}

export function simulatorApiRequest(host: string, command: 'start' | 'stop' | 'get' | 'command', input: {
  appId: string
  platform?: string
  name?: string
  id?: string
  buildJobId?: string
  deviceCommand?: string
  x?: number
  y?: number
  bundleId?: string
}) {
  const base = host.replace(/\/$/, '')
  if (command === 'start') {
    return {
      method: 'POST' as const,
      url: `${base}/build/simulator`,
      body: {
        app_id: input.appId,
        platform: input.platform,
        name: input.name,
        ...(input.buildJobId ? { build_job_id: input.buildJobId } : {}),
      },
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
  if (command === 'command') {
    return {
      method: 'POST' as const,
      url: `${base}/build/simulator/${input.id}/command`,
      body: {
        app_id: input.appId,
        command: input.deviceCommand,
        ...(input.x !== undefined ? { x: input.x } : {}),
        ...(input.y !== undefined ? { y: input.y } : {}),
        ...(input.bundleId ? { bundle_id: input.bundleId } : {}),
      },
    }
  }
  return {
    method: 'GET' as const,
    url: `${base}/build/simulator/${input.id}?app_id=${encodeURIComponent(input.appId)}`,
    body: undefined,
  }
}

export async function executeSimulator(command: 'start' | 'stop' | 'get' | 'command', appId: string, sessionId: string | undefined, options: SimulatorCommandOptions): Promise<SimulatorPayload> {
  const platform = options.platform ?? 'ios'
  if (platform !== 'ios' && platform !== 'android')
    fail('--platform must be ios or android')
  const apikey = options.apikey || findSavedKey()
  if (!apikey)
    fail('Missing API key. Pass --apikey or run capgo login.')
  const { apiHost } = await resolveCapgoApiHosts(options.apiHost)
  const request = simulatorApiRequest(apiHost, command, {
    appId,
    platform,
    name: options.name,
    id: sessionId,
    buildJobId: options.buildJobId,
    deviceCommand: options.deviceCommand,
    x: options.x,
    y: options.y,
    bundleId: options.bundleId,
  })
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
  return text ? JSON.parse(text) as SimulatorPayload : {}
}

export function simulatorMcpContent(payload: SimulatorPayload) {
  const image = payload.data?.image_base64
  const data = payload.data ? { ...payload.data } : undefined
  if (data)
    delete data.image_base64
  const content: Array<{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string }> = [
    { type: 'text', text: JSON.stringify({ ...payload, data }, null, 2) },
  ]
  if (image)
    content.push({ type: 'image', data: image, mimeType: payload.data?.image_media_type || 'image/jpeg' })
  return { content }
}

export function simulatorCommandTextOutput(payload: SimulatorPayload): { text: string, screenshot?: { name: string, base64: string } } {
  const data = payload.data
  if (data?.image_base64) {
    const name = `simulator-${data.id ?? 'screenshot'}.jpg`
    return { text: `${name}\n`, screenshot: { name, base64: data.image_base64 } }
  }
  if (data?.result !== undefined)
    return { text: `${JSON.stringify(data.result, null, 2)}\n` }
  return { text: simulatorTextOutput(data) }
}

export function simulatorStartOptions(options: SimulatorCommandOptions & { buildJob?: string }): SimulatorCommandOptions {
  return { ...options, buildJobId: options.buildJobId ?? options.buildJob }
}

function refuseScreenshotSymlink(filePath: string) {
  try {
    if (lstatSync(filePath).isSymbolicLink())
      throw new Error(`Refusing to write screenshot through a symbolic link: ${filePath}`)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
}

export function writeSimulatorScreenshot(filePath: string, base64: string) {
  const bytes = Buffer.from(base64, 'base64')
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  if (noFollow === 0)
    refuseScreenshotSymlink(filePath)
  let fd: number
  try {
    fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o644)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error(`Refusing to write screenshot through a symbolic link: ${filePath}`)
    throw error
  }
  try {
    writeSync(fd, bytes)
  }
  finally {
    closeSync(fd)
  }
}

async function callSimulator(command: 'start' | 'stop' | 'get' | 'command', appId: string, sessionId: string | undefined, options: SimulatorCommandOptions) {
  const payload = await executeSimulator(command, appId, sessionId, options)
  if (options.json) {
    stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }
  if (command === 'command') {
    const output = simulatorCommandTextOutput(payload)
    if (output.screenshot)
      writeSimulatorScreenshot(output.screenshot.name, output.screenshot.base64)
    stdout.write(output.text)
    return
  }
  stdout.write(simulatorTextOutput(payload.data))
}

export function simulatorTextOutput(data: { id?: string, url?: string, status?: string } | undefined) {
  const lines = [data?.id, data?.url].filter((line): line is string => Boolean(line))
  if (lines.length > 0)
    return `${lines.join('\n')}\n`
  return `${data?.status ?? 'ok'}\n`
}

export function startSimulatorCommand(appId: string | undefined, options: SimulatorCommandOptions & { buildJob?: string }) {
  if (!appId)
    fail('app id is required')
  return callSimulator('start', appId, undefined, simulatorStartOptions(options))
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

export function sendSimulatorCommand(deviceCommand: string | undefined, sessionId: string | undefined, appId: string | undefined, options: SimulatorCommandOptions) {
  if (!deviceCommand || !sessionId || !appId)
    fail('command, session id and app id are required')
  return callSimulator('command', appId, sessionId, { ...options, deviceCommand })
}
