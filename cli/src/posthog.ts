import type { Command } from 'commander'
import { homedir, platform, release } from 'node:os'
import { arch, cwd, env, version as nodeVersion } from 'node:process'
import pack from '../package.json'
import { CliUserError } from './shared/cli-user-error'

const POSTHOG_EXCEPTION_URL = 'https://eu.i.posthog.com/i/v0/e/'
const CAPGO_POSTHOG_PROJECT_TOKEN = 'phc_NXDyDajQaTQVwb25DEhIVZfxVUn4R0Y348Z7vWYHZUi'
const POSTHOG_TIMEOUT_MS = 1500

type CliPosthogExceptionKind = 'unhandled_error'

interface SerializedError {
  cause?: unknown
  message: string
  name: string
  stack?: string
}

interface CapturePosthogExceptionPayload {
  error: unknown
  functionName: string
  kind: CliPosthogExceptionKind
  status?: number
}

export function isTruthyEnvValue(value: string | undefined) {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes'
}

export function getPosthogToken() {
  if (isTruthyEnvValue(env.CAPGO_DISABLE_TELEMETRY) || isTruthyEnvValue(env.CAPGO_DISABLE_POSTHOG))
    return undefined

  return env.CAPGO_CLI_POSTHOG_API_KEY?.trim()
    || env.POSTHOG_API_KEY?.trim()
    || CAPGO_POSTHOG_PROJECT_TOKEN
}

function getPosthogExceptionUrl(host: string) {
  const trimmedHost = host.replace(/\/+$/, '')
  if (trimmedHost.endsWith('/i/v0/e'))
    return `${trimmedHost}/`

  const normalizedHost = trimmedHost.replace(/\/capture$/, '/')
  return new URL('i/v0/e/', normalizedHost.endsWith('/') ? normalizedHost : `${normalizedHost}/`).toString()
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      cause: error.cause,
      message: error.message,
      name: error.name || 'Error',
      stack: error.stack,
    }
  }

  if (typeof error === 'string') {
    return {
      message: error,
      name: 'Error',
      stack: undefined,
    }
  }

  try {
    const message = JSON.stringify(error)
    return {
      message: message ?? String(error),
      name: 'Error',
      stack: undefined,
    }
  }
  catch {
    return {
      message: String(error),
      name: 'Error',
      stack: undefined,
    }
  }
}

function sanitizeFilename(filename: string) {
  let sanitized = filename
  const workingDirectory = cwd()
  const homeDirectory = homedir()

  if (workingDirectory)
    sanitized = sanitized.replaceAll(workingDirectory, '<cwd>')
  if (homeDirectory)
    sanitized = sanitized.replaceAll(homeDirectory, '~')

  return sanitized
}

function sanitizeTelemetryText(value: string) {
  let sanitized = value
  const workingDirectory = cwd()
  const homeDirectory = homedir()

  if (workingDirectory)
    sanitized = sanitized.replaceAll(workingDirectory, '<cwd>')
  if (homeDirectory)
    sanitized = sanitized.replaceAll(homeDirectory, '~')

  return sanitized
    .replace(/<cwd>\/[^\s"',)]+/g, '<cwd>/<path>')
    .replace(/~\/[^\s"',)]+/g, '~/<path>')
    .replace(/[\w.%+-]+@[\w.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1<redacted>@')
    .replace(/\b[a-z][\w-]*(?:\.[\w-]+){2,}\b/gi, '<app_id>')
    .replace(/\b[a-z]:\\[^\s"',)]+/gi, '<path>')
    .replace(/(^|[\s"'(])\/[^\s"',)]+/g, '$1<path>')
    .replace(/(--(?:token|api[-_]?key|key|password|secret|private[-_]?key|jwt|session|auth)(?:=|\s+))("[^"]+"|'[^']+'|\S+)/gi, '$1<redacted>')
    .replace(/\b((?:token|api[-_]?key|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1<redacted>')
}

function parseExceptionFrames(stack: string | undefined, fallbackFunctionName: string) {
  const frames = stack?.split('\n')
    .slice(1)
    .map((line) => {
      const trimmed = line.trim()
      const withoutAt = trimmed.startsWith('at ') ? trimmed.slice(3) : trimmed
      let functionName = fallbackFunctionName
      let location = withoutAt

      const groupedLocationIndex = withoutAt.lastIndexOf(' (')
      if (groupedLocationIndex !== -1 && withoutAt.endsWith(')')) {
        functionName = withoutAt.slice(0, groupedLocationIndex).trim() || fallbackFunctionName
        location = withoutAt.slice(groupedLocationIndex + 2, -1)
      }
      else {
        const lastSpaceIndex = withoutAt.lastIndexOf(' ')
        const possibleLocation = lastSpaceIndex === -1 ? '' : withoutAt.slice(lastSpaceIndex + 1)
        if (/:\d+:\d+$/.test(possibleLocation)) {
          functionName = withoutAt.slice(0, lastSpaceIndex).trim() || fallbackFunctionName
          location = possibleLocation
        }
      }

      const lastColonIndex = location.lastIndexOf(':')
      const secondLastColonIndex = lastColonIndex === -1 ? -1 : location.lastIndexOf(':', lastColonIndex - 1)
      if (lastColonIndex === -1 || secondLastColonIndex === -1) {
        return {
          function: fallbackFunctionName,
          platform: 'custom',
          lang: 'javascript',
        }
      }

      return {
        function: functionName,
        filename: sanitizeFilename(location.slice(0, secondLastColonIndex)),
        lineno: Number.parseInt(location.slice(secondLastColonIndex + 1, lastColonIndex), 10),
        colno: Number.parseInt(location.slice(lastColonIndex + 1), 10),
        platform: 'custom',
        lang: 'javascript',
      }
    })
    .filter(Boolean)

  return frames && frames.length > 0
    ? frames
    : [{
        function: fallbackFunctionName,
        platform: 'custom',
        lang: 'javascript',
      }]
}

function getCommanderCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined

  const { code } = error as { code?: unknown }
  return typeof code === 'string' ? code : undefined
}

export function shouldCapturePosthogException(error: unknown) {
  // Expected user-facing failures (missing input, a channel with no bundle,
  // insufficient permissions, …) are legitimate states, not crashes — never
  // open an error tracking issue for them.
  if (error instanceof CliUserError)
    return false
  return !getCommanderCode(error)?.startsWith('commander.')
}

export function getCommandPath(command: Command) {
  const names: string[] = []
  let current: Command | null | undefined = command

  while (current?.parent) {
    const name = current.name()
    if (name)
      names.push(name)
    current = current.parent
  }

  return names.reverse().join(' ') || 'unknown'
}

export async function capturePosthogException(payload: CapturePosthogExceptionPayload) {
  const token = getPosthogToken()
  if (!token)
    return false

  const host = env.CAPGO_CLI_POSTHOG_API_HOST?.trim() || env.POSTHOG_API_HOST?.trim() || POSTHOG_EXCEPTION_URL
  let posthogUrl: string
  try {
    posthogUrl = getPosthogExceptionUrl(host)
  }
  catch {
    return false
  }

  const serializedError = serializeError(payload.error)
  const sanitizedMessage = sanitizeTelemetryText(serializedError.message)
  const distinctId = `cli:${pack.version}:${payload.functionName}`
  const frames = parseExceptionFrames(serializedError.stack, payload.functionName)
  const topFrame = frames[0]
  // Deliberately exclude the CLI version from the fingerprint so the same bug
  // stays a single error-tracking issue across releases instead of minting a
  // brand-new issue on every version bump.
  const fingerprint = [
    payload.functionName,
    payload.kind,
    serializedError.name || 'Error',
    topFrame?.function || payload.functionName,
    topFrame && 'filename' in topFrame ? topFrame.filename : 'unknown',
    String(payload.status ?? 1),
  ].join(':')

  const body = {
    token,
    event: '$exception',
    properties: {
      distinct_id: distinctId,
      $exception_list: [{
        type: serializedError.name || 'Error',
        value: sanitizedMessage,
        mechanism: {
          handled: true,
          synthetic: false,
        },
        stacktrace: {
          type: 'raw',
          frames,
        },
      }],
      $exception_fingerprint: fingerprint,
      architecture: arch,
      cli_version: pack.version,
      error_kind: payload.kind,
      function_name: payload.functionName,
      is_ci: Boolean(env.CI),
      node_version: nodeVersion,
      os_platform: platform(),
      os_release: release(),
      runtime: 'cli',
      status: payload.status,
    },
    timestamp: new Date().toISOString(),
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), POSTHOG_TIMEOUT_MS)
    try {
      const res = await fetch(posthogUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      return res.ok
    }
    finally {
      clearTimeout(timeoutId)
    }
  }
  catch {
    return false
  }
}
