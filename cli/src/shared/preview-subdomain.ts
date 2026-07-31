const PREVIEW_VERSION_SEPARATOR = '-'
const PREVIEW_CHANNEL_PREFIX = 'c'
const DNS_LABEL_MAX_LENGTH = 63

function isLowercaseAlphaNumeric(char: string) {
  return /^[a-z0-9]$/.test(char)
}

function isDirectPreviewCharacter(char: string) {
  return isLowercaseAlphaNumeric(char) || char === '_'
}

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

export function encodePreviewAppId(appId: string): string {
  return Array.from(appId).map(char => isDirectPreviewCharacter(char) ? char : encodeEscapedByte(char)).join('')
}

function buildEncodedPreviewSubdomain(target: string, appId: string): string {
  const label = `${target}${PREVIEW_VERSION_SEPARATOR}${encodePreviewAppId(appId)}`
  if (label.length > DNS_LABEL_MAX_LENGTH)
    throw new Error(`Preview subdomain exceeds DNS label limit: "${label}" (${label.length} characters)`)
  return label
}

export function buildPreviewSubdomain(appId: string, versionId: number): string {
  assertValidPreviewVersionId(versionId)
  return buildEncodedPreviewSubdomain(String(versionId), appId)
}

export function buildChannelPreviewSubdomain(appId: string, channelId: number): string {
  assertValidPreviewChannelId(channelId)
  return buildEncodedPreviewSubdomain(`${PREVIEW_CHANNEL_PREFIX}${channelId}`, appId)
}
