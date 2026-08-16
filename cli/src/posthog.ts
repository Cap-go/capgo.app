import type { Command } from 'commander'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform, release } from 'node:os'
import { join } from 'node:path'
import { arch, cwd, env, version as nodeVersion } from 'node:process'
import pack from '../package.json'
import { CliUserError } from './shared/cli-user-error'

const POSTHOG_EXCEPTION_URL = 'https://eu.i.posthog.com/i/v0/e/'
const CAPGO_POSTHOG_PROJECT_TOKEN = 'phc_NXDyDajQaTQVwb25DEhIVZfxVUn4R0Y348Z7vWYHZUi'
const POSTHOG_TIMEOUT_MS = 1500

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/')
    end -= 1
  return value.slice(0, end)
}

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
  const trimmedHost = trimTrailingSlashes(host)
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
    .replace(/\b[a-z][\w-]*(?:\.[\w-]+){1,}\b/gi, '<app_id>')
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

// Lowercased markers for expected user-configuration failures (bad/missing API
// key, app not created yet). These are surfaced with the backend error codes or
// the CLI's own wording — matched case-insensitively against the error message.
const EXPECTED_USER_ERROR_MARKERS = [
  'invalid_apikey',
  'invalid apikey',
  'no_key_provided',
  'no key provided',
  'invalid api key or insufficient permissions',
  'does not exist, run first',
]

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object')
    return undefined
  const candidate = error as { status?: unknown, statusCode?: unknown, context?: { status?: unknown } }
  if (typeof candidate.status === 'number')
    return candidate.status
  if (typeof candidate.statusCode === 'number')
    return candidate.statusCode
  // supabase-js FunctionsHttpError keeps the upstream Response on `.context`.
  const contextStatus = candidate.context && typeof candidate.context === 'object'
    ? (candidate.context as { status?: unknown }).status
    : undefined
  return typeof contextStatus === 'number' ? contextStatus : undefined
}

/**
 * Expected user-configuration failures: a bad or missing API key (401
 * `invalid_apikey` / `no_key_provided`) or an app that has not been created
 * yet. These are real user errors, not CLI bugs — they are still counted via
 * `trackCommandFailed`, but must NOT be sent to error tracking as exceptions.
 */
export function isExpectedUserError(error: unknown) {
  const message = (error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : '').toLowerCase()

  if (EXPECTED_USER_ERROR_MARKERS.some(marker => message.includes(marker)))
    return true

  // A 401 from any Capgo endpoint is an auth/config problem on the caller side.
  return getErrorStatus(error) === 401
}

export function shouldCapturePosthogException(error: unknown) {
  // Expected user-facing failures (CliUserError, bad/missing key, app not
  // created, …) are legitimate states, not crashes — never open an error
  // tracking issue for them.
  if (error instanceof CliUserError || isExpectedUserError(error))
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

// Anonymous, stable per-install identifier used as the PostHog `distinct_id`.
// It carries no personal data — a random id generated once and persisted in the
// CLI config directory. The previous `cli:<version>:<command>` value was not a
// person at all, so "users affected" on every CLI error-tracking issue counted
// version-by-command pairs, and each release minted a fresh synthetic person.
// The install id keeps one install equal to one person, stable across releases
// and commands. The CLI version and command name still ship as the `cli_version`
// and `function_name` properties.
let cachedInstallId: string | undefined

export function getInstallId(configDir = join(homedir(), '.capgo-credentials')): string {
  if (cachedInstallId)
    return cachedInstallId

  const installIdPath = join(configDir, 'install-id')
  let id: string
  try {
    const existing = existsSync(installIdPath) ? readFileSync(installIdPath, 'utf8').trim() : ''
    if (existing) {
      id = existing
    }
    else {
      id = randomUUID()
      mkdirSync(configDir, { recursive: true })
      writeFileSync(installIdPath, id, { encoding: 'utf8', mode: 0o600 })
    }
  }
  catch {
    // A read-only or unwritable HOME (CI, sandbox) must never break telemetry.
    // Fall back to an ephemeral id so the event still sends; it just cannot
    // persist, so it stays stable only for the current process.
    id = randomUUID()
  }
  cachedInstallId = id
  return id
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
  const distinctId = getInstallId()
  const frames = parseExceptionFrames(serializedError.stack, payload.functionName)
  // Fingerprint deliberately omits both the CLI version and the top stack frame
  // (its function name and filename). The CLI ships as one minified
  // `dist/index.js`, so the top-frame symbol is renamed on every release and the
  // filename is the full install path — which differs per npx cache hash, bunx,
  // pnpm store, global install, or sandbox. Keeping either splits one bug into a
  // fresh error-tracking issue per install location and per release. The command
  // path, error kind, error name, and exit status stay stable across all of them.
  // Version is still reported via `cli_version` below.
  const fingerprint = [
    payload.functionName,
    payload.kind,
    serializedError.name || 'Error',
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
