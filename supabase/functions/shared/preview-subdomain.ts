const PREVIEW_HOSTNAME_REGEX = /^([^.]+)\.preview(?:\.[^.]+)?\.(?:capgo\.app|usecapgo\.com)$/
const PREVIEW_VERSION_SEPARATOR = '-'
const PREVIEW_CHANNEL_PREFIX = 'c'
const DNS_LABEL_MAX_LENGTH = 63

/**
 * Parsed preview hostname information after the preview subdomain is decoded.
 */
export interface ParsedBundlePreviewSubdomain {
  appId: string
  versionId: number
}

export interface ParsedChannelPreviewSubdomain {
  appId: string
  channelId: number
}

export type ParsedPreviewSubdomain = ParsedBundlePreviewSubdomain | ParsedChannelPreviewSubdomain

/**
 * Returns whether a character can be emitted directly inside the DNS-safe label.
 */
function isLowercaseAlphaNumeric(char: string) {
  return /^[a-z0-9]$/.test(char)
}

/**
 * Returns whether a character can be emitted directly inside the preview app-id payload.
 */
function isDirectPreviewCharacter(char: string) {
  return isLowercaseAlphaNumeric(char) || char === '_'
}

/**
 * Escapes a single character into a compact reversible preview token.
 */
function encodeEscapedByte(char: string) {
  if (char === '.')
    return '-0'

  if (char === '-')
    return '-1'

  if (/^[A-Z]$/.test(char))
    return `-${char.toLowerCase()}`

  throw new Error(`Unsupported preview app id character: ${char}`)
}

function assertValidPreviewVersionId(versionId: number): void {
  if (!Number.isSafeInteger(versionId) || versionId < 0)
    throw new Error(`Invalid preview version id: ${versionId}`)
}

function assertValidPreviewChannelId(channelId: number): void {
  if (!Number.isSafeInteger(channelId) || channelId <= 0)
    throw new Error(`Invalid preview channel id: ${channelId}`)
}

/**
 * Encodes an app ID into a reversible DNS-safe preview subdomain label.
 */
export function encodePreviewAppId(appId: string): string {
  return Array.from(appId).map(char => isDirectPreviewCharacter(char) ? char : encodeEscapedByte(char)).join('')
}

function buildEncodedPreviewSubdomain(target: string, appId: string): string {
  const label = `${target}${PREVIEW_VERSION_SEPARATOR}${encodePreviewAppId(appId)}`
  if (label.length > DNS_LABEL_MAX_LENGTH)
    throw new Error(`Preview subdomain exceeds DNS label limit: "${label}" (${label.length} characters)`)
  return label
}

/**
 * Builds the preview subdomain label used before `.preview.capgo.app`.
 */
export function buildPreviewSubdomain(appId: string, versionId: number): string {
  assertValidPreviewVersionId(versionId)
  return buildEncodedPreviewSubdomain(String(versionId), appId)
}

/**
 * Builds the preview subdomain label for stable channel previews.
 */
export function buildChannelPreviewSubdomain(appId: string, channelId: number): string {
  assertValidPreviewChannelId(channelId)
  return buildEncodedPreviewSubdomain(`${PREVIEW_CHANNEL_PREFIX}${channelId}`, appId)
}

/**
 * Decodes a DNS-safe preview label back to its original app ID.
 */
export function decodePreviewAppId(encodedAppId: string): string | null {
  let decoded = ''

  for (let index = 0; index < encodedAppId.length; index += 1) {
    const char = encodedAppId[index]
    if (char !== '-') {
      if (!isDirectPreviewCharacter(char))
        return null
      decoded += char
      continue
    }

    const escapedByte = encodedAppId[index + 1]
    if (!escapedByte)
      return null

    if (escapedByte === '0') {
      decoded += '.'
      index += 1
      continue
    }

    if (escapedByte === '1') {
      decoded += '-'
      index += 1
      continue
    }

    if (/^[a-z]$/.test(escapedByte)) {
      decoded += escapedByte.toUpperCase()
      index += 1
      continue
    }

    return null
  }

  return decoded
}

/**
 * Parses a numeric version identifier and rejects malformed values.
 */
function parseVersionId(value: string): number | null {
  if (!/^\d+$/.test(value))
    return null

  const versionId = Number.parseInt(value, 10)
  return Number.isSafeInteger(versionId) ? versionId : null
}

function parseChannelId(value: string): number | null {
  const channelId = parseVersionId(value)
  if (channelId === null || channelId <= 0)
    return null
  return channelId
}

/**
 * Parses the new reversible preview subdomain format.
 */
function parseEncodedPreviewSubdomain(subdomain: string): ParsedPreviewSubdomain | null {
  const separatorIndex = subdomain.indexOf(PREVIEW_VERSION_SEPARATOR)
  if (separatorIndex <= 0)
    return null

  const target = subdomain.slice(0, separatorIndex)
  const encodedAppId = subdomain.slice(separatorIndex + PREVIEW_VERSION_SEPARATOR.length)
  const appId = decodePreviewAppId(encodedAppId)
  if (!appId)
    return null

  if (target.startsWith(PREVIEW_CHANNEL_PREFIX)) {
    const channelId = parseChannelId(target.slice(PREVIEW_CHANNEL_PREFIX.length))
    if (channelId === null)
      return null

    return { appId, channelId }
  }

  const versionId = parseVersionId(target)
  if (versionId === null)
    return null

  return { appId, versionId }
}

/**
 * Parses a reversible preview subdomain label.
 *
 * Legacy hostnames that used `__` for dots are intentionally rejected: that
 * encoding is not bijective, so distinct app IDs can collide on one public
 * hostname (for example `com.example.app` and `com.example__app` both mapped to
 * `com__example__app`). Callers must use bijective labels from
 * `buildPreviewSubdomain` / `buildChannelPreviewSubdomain`.
 */
export function parsePreviewSubdomain(subdomain: string): ParsedPreviewSubdomain | null {
  return parseEncodedPreviewSubdomain(subdomain)
}

/**
 * Extracts and parses the preview label from a full preview hostname.
 */
export function parsePreviewHostname(hostname: string): ParsedPreviewSubdomain | null {
  const match = PREVIEW_HOSTNAME_REGEX.exec(hostname)
  if (!match)
    return null

  return parsePreviewSubdomain(match[1])
}
