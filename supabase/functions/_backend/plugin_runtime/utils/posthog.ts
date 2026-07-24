import type { TrackOptions } from '@logsnag/node'
import type { Context } from 'hono'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { existInEnv, getEnv } from './utils.ts'

const POSTHOG_CAPTURE_URL = 'https://eu.i.posthog.com/capture/'
const POSTHOG_EXCEPTION_URL = 'https://eu.i.posthog.com/i/v0/e/'
const POSTHOG_SNAPSHOT_URL = 'https://eu.i.posthog.com/s/'
const POSTHOG_DELIVERY_TIMEOUT_MS = 5000

export type PostHogGroups = Record<string, string>

interface PostHogCapturePayload extends Pick<TrackOptions, 'event'>, Pick<TrackOptions, 'channel' | 'description'> {
  distinct_id?: string
  groups?: PostHogGroups
  ip?: string
  setPersonProperties?: boolean
  tags?: Record<string, any>
  nonPersonTags?: Record<string, any>
  timestamp?: string
  user_id?: string
}

export async function trackPosthogEvent(c: Context, payload: PostHogCapturePayload) {
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY')) {
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog not configured' })
    return false
  }

  const host = getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_CAPTURE_URL
  const posthogUrl = host.endsWith('/capture/')
    ? host
    : new URL('capture/', host.endsWith('/') ? host : `${host}/`).toString()

  const distinctId = payload.user_id || payload.distinct_id || 'anonymous'

  const hasGroups = payload.groups && Object.keys(payload.groups).length > 0

  // `tags` become BOTH event properties and PostHog person properties ($set).
  // `nonPersonTags` are event properties ONLY — never $set — for volatile
  // per-event context (e.g. the CLI's global runtime props) that must not
  // become last-write-wins identity traits on the actor.
  const properties = {
    ...(payload.nonPersonTags || {}),
    ...(payload.tags || {}),
    channel: payload.channel,
    description: payload.description,
    ...(payload.setPersonProperties === false ? {} : { $set: payload.tags }),
    ...(hasGroups ? { $groups: payload.groups } : {}),
  }

  const body = {
    api_key: apiKey,
    event: payload.event,
    distinct_id: distinctId,
    properties,
    ip: payload.ip,
    timestamp: payload.timestamp ?? new Date().toISOString(),
  }

  try {
    const res = await fetch(posthogUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const error = await res.text()
      cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog error', status: res.status, error, event: payload.event, distinctId })
      return false
    }

    cloudlog({ requestId: c.get('requestId'), message: 'PostHog event sent', event: payload.event, distinctId })
    return true
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog fetch failed', error: serializeError(e), event: payload.event, distinctId })
    return false
  }
}

function trimTrailingSlashes(value: string) {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47)
    end--
  return value.slice(0, end)
}

function stripPostHogEndpoint(host: string) {
  for (const suffix of ['/i/v0/e', '/capture', '/e']) {
    if (host.endsWith(suffix))
      return `${host.slice(0, -suffix.length)}/`
  }
  return host
}

function getPostHogSnapshotUrl(host: string) {
  const trimmedHost = trimTrailingSlashes(host)
  if (trimmedHost.endsWith('/s'))
    return `${trimmedHost}/`

  const normalizedHost = stripPostHogEndpoint(trimmedHost)
  return new URL('s/', normalizedHost.endsWith('/') ? normalizedHost : `${normalizedHost}/`).toString()
}
function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

export interface PostHogReplaySnapshotPayload {
  currentUrl: string
  distinctId: string
  events: unknown[]
  lib: string
  libVersion: string
  sessionId: string
  snapshotBytes?: number
  timestamp: string
  userEmail?: string
  userId: string
  windowId: string
}

export async function capturePosthogReplaySnapshot(c: Context, payload: PostHogReplaySnapshotPayload) {
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY')) {
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog not configured' })
    return false
  }

  const host = getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_SNAPSHOT_URL
  let posthogUrl: string
  try {
    posthogUrl = getPostHogSnapshotUrl(host)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid PostHog replay host', error: serializeError(e), host })
    return false
  }

  const body = {
    api_key: apiKey,
    distinct_id: payload.distinctId,
    event: '$snapshot',
    properties: {
      $current_url: payload.currentUrl,
      $lib: payload.lib,
      $lib_version: payload.libVersion,
      $session_id: payload.sessionId,
      ...(payload.userEmail ? { $set: { email: payload.userEmail } } : {}),
      $snapshot_bytes: payload.snapshotBytes ?? jsonByteLength(payload.events),
      $snapshot_data: payload.events,
      $snapshot_source: 'web',
      $window_id: payload.windowId,
      distinct_id: payload.distinctId,
      token: apiKey,
      user_id: payload.userId,
    },
    timestamp: payload.timestamp,
  }
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), POSTHOG_DELIVERY_TIMEOUT_MS)
    try {
      const res = await fetch(posthogUrl, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })

      if (!res.ok) {
        const error = await res.text()
        cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog replay error', status: res.status, error, sessionId: payload.sessionId, distinctId: payload.distinctId })
        return false
      }

      cloudlog({ requestId: c.get('requestId'), message: 'PostHog replay sent', sessionId: payload.sessionId, distinctId: payload.distinctId })
      return true
    }
    finally {
      clearTimeout(timeoutId)
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog replay fetch failed', error: serializeError(e), sessionId: payload.sessionId, distinctId: payload.distinctId })
    return false
  }
}

function getPostHogExceptionUrl(host: string) {
  const trimmedHost = trimTrailingSlashes(host)
  if (trimmedHost.endsWith('/i/v0/e'))
    return `${trimmedHost}/`

  const normalizedHost = trimmedHost.endsWith('/capture') ? `${trimmedHost.slice(0, -'/capture'.length)}/` : trimmedHost
  return new URL('i/v0/e/', normalizedHost.endsWith('/') ? normalizedHost : `${normalizedHost}/`).toString()
}
function getRequestPath(url: string) {
  try {
    return new URL(url).pathname || '/'
  }
  catch {
    return '/'
  }
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
        filename: location.slice(0, secondLastColonIndex),
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

export async function capturePosthogException(c: Context, payload: {
  error: unknown
  functionName: string
  kind: 'drizzle_error' | 'http_exception' | 'unhandled_error'
  status?: number
}) {
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY')) {
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog not configured' })
    return false
  }

  const host = getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_EXCEPTION_URL
  let posthogUrl: string
  try {
    posthogUrl = getPostHogExceptionUrl(host)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid PostHog host', error: serializeError(e), host })
    return false
  }
  const serializedError = serializeError(payload.error)
  const distinctId = `backend:${getEnv(c, 'ENV_NAME') || 'unknown'}:${payload.functionName}`
  const frames = parseExceptionFrames(serializedError.stack, payload.functionName)
  const topFrame = frames[0]
  const requestPath = getRequestPath(c.req.url)
  const fingerprint = [
    distinctId,
    payload.kind,
    serializedError.name || 'Error',
    topFrame?.function || payload.functionName,
    topFrame?.filename || 'unknown',
    String(payload.status ?? 500),
  ].join(':')

  const body = {
    token: apiKey,
    event: '$exception',
    properties: {
      distinct_id: distinctId,
      $exception_list: [{
        type: serializedError.name || 'Error',
        value: serializedError.message,
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
      error_kind: payload.kind,
      function_name: payload.functionName,
      method: c.req.method,
      request_id: c.get('requestId'),
      status: payload.status,
      url_path: requestPath,
    },
    timestamp: new Date().toISOString(),
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), POSTHOG_DELIVERY_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(posthogUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
    }
    catch (fetchError) {
      clearTimeout(timeoutId)
      throw fetchError
    }
    if (!res.ok) {
      const error = await res.text()
      cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog exception error', status: res.status, error, event: '$exception', distinctId })
      return false
    }

    cloudlog({ requestId: c.get('requestId'), message: 'PostHog exception sent', event: '$exception', distinctId })
    return true
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog exception fetch failed', error: serializeError(e), event: '$exception', distinctId })
    return false
  }
}

export interface PostHogGroupIdentifyPayload {
  groupType: string
  groupKey: string
  properties?: Record<string, unknown>
}

export async function groupIdentifyPosthog(c: Context, payload: PostHogGroupIdentifyPayload) {
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY')) {
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog not configured' })
    return false
  }

  const host = getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_CAPTURE_URL
  const posthogUrl = host.endsWith('/capture/')
    ? host
    : new URL('capture/', host.endsWith('/') ? host : `${host}/`).toString()

  const body = {
    api_key: apiKey,
    event: '$groupidentify',
    distinct_id: `$${payload.groupType}_${payload.groupKey}`,
    properties: {
      $group_type: payload.groupType,
      $group_key: payload.groupKey,
      $group_set: payload.properties ?? {},
    },
    timestamp: new Date().toISOString(),
  }

  try {
    const res = await fetch(posthogUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const error = await res.text()
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'PostHog $groupidentify error',
        status: res.status,
        error,
        groupType: payload.groupType,
        groupKey: payload.groupKey,
      })
      return false
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'PostHog $groupidentify sent',
      groupType: payload.groupType,
      groupKey: payload.groupKey,
    })
    return true
  }
  catch (e) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'PostHog $groupidentify fetch failed',
      error: serializeError(e),
      groupType: payload.groupType,
      groupKey: payload.groupKey,
    })
    return false
  }
}
