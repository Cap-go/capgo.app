import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { cloudlog } from './logging.ts'

export const CAPGO_API_VERSION_HEADER = 'capgo_api' as const
export const CAPGO_API_DEFAULT_VERSION = '2025-10-01' as const

type VersionParts = [number, number, number]

export type CapgoApiVersionHandler<T> = (info: Readonly<CapgoApiVersionInfo>) => T

export interface CapgoApiVersionSwitch<T> {
  default?: CapgoApiVersionHandler<T>
  [version: string]: CapgoApiVersionHandler<T> | undefined
}

export interface CapgoApiVersionInfo {
  headerName: typeof CAPGO_API_VERSION_HEADER
  raw: string
  normalized: string
  parts: VersionParts
  major: number
  minor: number
  patch: number
  isDefault: boolean
  equals: (target: string) => boolean
  atLeast: (target: string) => boolean
  before: (target: string) => boolean
  handle: <T>(handlers: CapgoApiVersionSwitch<T>) => T
}

function parseVersion(value: string, c: Context): VersionParts {
  const trimmed = value.trim()
  const withoutPrefix = trimmed.replace(/^v/i, '')
  if (!withoutPrefix) {
    throw versionError(c, 'invalid_capgo_api_version', 'Invalid capgo_api version header', {
      header: value,
      reason: 'empty_version',
    })
  }

  const split = withoutPrefix.split(/[._-]/)
  if (split.length > 3) {
    throw versionError(c, 'invalid_capgo_api_version', 'Invalid capgo_api version header', {
      header: value,
      reason: 'too_many_segments',
    })
  }

  const parsed = split.map((segment) => {
    if (!/^\d+$/.test(segment)) {
      throw versionError(c, 'invalid_capgo_api_version', 'Invalid capgo_api version header', {
        header: value,
        reason: 'non_numeric_segment',
        segment,
      })
    }
    return Number.parseInt(segment, 10)
  })

  while (parsed.length < 3) {
    parsed.push(0)
  }

  return parsed.slice(0, 3) as VersionParts
}

function compareVersions(a: VersionParts, b: VersionParts) {
  for (let index = 0; index < 3; index++) {
    const diff = a[index] - b[index]
    if (diff !== 0) {
      return Math.sign(diff)
    }
  }
  return 0
}

function parseTargetVersion(target: string, c: Context): VersionParts {
  return parseVersion(target, c)
}

function versionError(
  c: Context,
  errorCode: 'invalid_capgo_api_version' | 'unsupported_capgo_api_version' | 'missing_capgo_api_version_handler',
  message: string,
  moreInfo: Record<string, unknown>,
): HTTPException {
  const payload = {
    error: errorCode,
    message,
    moreInfo,
  }

  cloudlog({
    requestId: c.get('requestId'),
    message,
    errorCode,
    moreInfo,
  })

  return new HTTPException(400, {
    message,
    res: new Response(JSON.stringify(payload), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  })
}

function handleSwitch<T>(info: CapgoApiVersionInfo, handlers: CapgoApiVersionSwitch<T>, c: Context): T {
  for (const [version, handler] of Object.entries(handlers)) {
    if (version === 'default' || typeof handler !== 'function') {
      continue
    }

    const targetParts = parseTargetVersion(version, c)
    if (compareVersions(info.parts, targetParts) === 0) {
      return handler(info)
    }
  }

  if (handlers.default) {
    return handlers.default(info)
  }

  if (info.isDefault) {
    throw versionError(
      c,
      'missing_capgo_api_version_handler',
      'No handler registered for the default capgo_api version',
      { normalized: info.normalized },
    )
  }

  throw versionError(
    c,
    'unsupported_capgo_api_version',
    'Unsupported capgo_api version requested',
    { requested: info.raw, normalized: info.normalized },
  )
}

export function resolveCapgoApiVersion(
  c: Context,
  options: { defaultVersion?: string } = {},
): CapgoApiVersionInfo {
  const headerValue = c.req.header(CAPGO_API_VERSION_HEADER)
  const trimmedHeader = headerValue?.trim() ?? ''
  const defaultVersion = options.defaultVersion ?? CAPGO_API_DEFAULT_VERSION
  const effectiveValue = trimmedHeader.length ? trimmedHeader : defaultVersion
  const parts = parseVersion(effectiveValue, c)
  const normalized = parts.join('.')

  const equals = (target: string) => compareVersions(parts, parseTargetVersion(target, c)) === 0
  const atLeast = (target: string) => compareVersions(parts, parseTargetVersion(target, c)) >= 0
  const before = (target: string) => compareVersions(parts, parseTargetVersion(target, c)) < 0

  const info: CapgoApiVersionInfo = {
    headerName: CAPGO_API_VERSION_HEADER,
    raw: effectiveValue,
    normalized,
    parts,
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    isDefault: trimmedHeader.length === 0,
    equals,
    atLeast,
    before,
    handle: <T>(handlers: CapgoApiVersionSwitch<T>) => handleSwitch(info, handlers, c),
  }

  return info
}
