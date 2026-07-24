/**
 * Zero-dependency fast predicate for stats request bodies.
 *
 * Mirrors the success path of `statsRequestSchema` in plugin_validation.ts.
 * On miss, the handrolled schema still builds the existing error issues.
 */

import { ALLOWED_STATS_ACTIONS_SET } from '../../plugins/stats_actions.ts'

const reverseDomainRegex = /^[a-z0-9]+(?:\.[\w-]+)+$/i
const deviceIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_STATS_METADATA_FIELDS = 30
const MAX_STATS_METADATA_KEY_LENGTH = 64
const MAX_STATS_METADATA_VALUE_LENGTH = 2048

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalStringMaxLength(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength)
}

function isValidStatsMetadata(metadata: unknown): boolean {
  if (metadata === undefined)
    return true
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
    return false

  const entries = Object.entries(metadata)
  if (entries.length > MAX_STATS_METADATA_FIELDS)
    return false

  for (const [key, value] of entries) {
    if (key.length > MAX_STATS_METADATA_KEY_LENGTH)
      return false
    if (typeof value !== 'string' || value.length > MAX_STATS_METADATA_VALUE_LENGTH)
      return false
  }
  return true
}

export function isStatsRequestBody(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return false

  const value = input as Record<string, unknown>

  if (typeof value.app_id !== 'string' || !reverseDomainRegex.test(value.app_id))
    return false
  if (typeof value.device_id !== 'string' || value.device_id.length > 36 || !deviceIdRegex.test(value.device_id))
    return false
  if (typeof value.platform !== 'string')
    return false
  if (typeof value.version_name !== 'string')
    return false
  if (typeof value.version_os !== 'string')
    return false
  if (typeof value.is_emulator !== 'boolean' || typeof value.is_prod !== 'boolean')
    return false

  if (!isOptionalString(value.defaultChannel)
    || !isOptionalString(value.channel)
    || !isOptionalString(value.old_version_name)
    || !isOptionalString(value.version_code)
    || !isOptionalString(value.plugin_version)
    || !isOptionalStringMaxLength(value.install_source, 64)
    || !isOptionalStringMaxLength(value.custom_id, 36)
    || !isOptionalStringMaxLength(value.key_id, 20)
    || !isOptionalString(value.version_build)) {
    return false
  }

  if (value.action !== undefined
    && (typeof value.action !== 'string' || !ALLOWED_STATS_ACTIONS_SET.has(value.action))) {
    return false
  }

  return isValidStatsMetadata(value.metadata)
}
