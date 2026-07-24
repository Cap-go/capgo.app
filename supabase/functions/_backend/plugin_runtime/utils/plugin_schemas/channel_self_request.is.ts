/**
 * Zero-dependency fast predicate for channel_self set/delete request bodies.
 *
 * Mirrors the success path of `channelSelfRequestSchema` in plugin_validation.ts.
 */

const reverseDomainRegex = /^[a-z0-9]+(?:\.[\w-]+)+$/i
const deviceIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalStringMaxLength(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength)
}

function isDevicePlatform(value: unknown): boolean {
  return value === 'ios' || value === 'android' || value === 'electron'
}

export function isChannelSelfRequestBody(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return false

  const value = input as Record<string, unknown>

  if (typeof value.app_id !== 'string' || !reverseDomainRegex.test(value.app_id))
    return false
  if (typeof value.device_id !== 'string' || value.device_id.length > 36 || !deviceIdRegex.test(value.device_id))
    return false
  if (typeof value.version_name !== 'string')
    return false
  if (typeof value.version_build !== 'string')
    return false
  if (typeof value.is_emulator !== 'boolean' || typeof value.is_prod !== 'boolean')
    return false
  if (!isDevicePlatform(value.platform))
    return false

  if (!isOptionalString(value.defaultChannel)
    || !isOptionalString(value.channel)
    || !isOptionalString(value.plugin_version)
    || !isOptionalStringMaxLength(value.install_source, 64)
    || !isOptionalStringMaxLength(value.key_id, 20)) {
    return false
  }

  return true
}
