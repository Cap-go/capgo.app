import type { StandardSchema, ValidationIssue } from './schema_validation.ts'
import type { AppInfos, AppStats } from './types.ts'
import { canParse } from '@std/semver'
import { ALLOWED_STATS_ACTIONS, ALLOWED_STATS_ACTIONS_SET } from '../plugins/stats_actions.ts'
import {
  createSchema,
  makeIssue,
} from './schema_validation.ts'
import { isChannelSelfRequestBody } from './plugin_schemas/channel_self_request.is.ts'
import { isStatsRequestBody } from './plugin_schemas/stats_request.is.ts'
import { isUpdateRequestBody } from './plugin_schemas/update_request.is.ts'
import {
  deviceIdRegex,
  INVALID_STRING_APP_ID,
  INVALID_STRING_DEVICE_ID,
  INVALID_STRING_PLATFORM,
  INVALID_STRING_PLUGIN_VERSION,
  MISSING_STRING_APP_ID,
  MISSING_STRING_DEVICE_ID,
  MISSING_STRING_PLATFORM,
  MISSING_STRING_PLUGIN_VERSION,
  MISSING_STRING_VERSION_BUILD,
  MISSING_STRING_VERSION_NAME,
  MISSING_STRING_VERSION_OS,
  NON_STRING_APP_ID,
  NON_STRING_DEVICE_ID,
  NON_STRING_PLATFORM,
  NON_STRING_VERSION_BUILD,
  NON_STRING_VERSION_NAME,
  NON_STRING_VERSION_OS,
  reverseDomainRegex,
} from './utils.ts'

let allowedStatsActionsList: string | undefined

function getAllowedStatsActionsList() {
  return allowedStatsActionsList ??= ALLOWED_STATS_ACTIONS.join(', ')
}

type UnknownRecord = Record<string, unknown>
type DevicePlatform = 'ios' | 'android' | 'electron'

const MAX_STATS_METADATA_FIELDS = 30
const MAX_STATS_METADATA_KEY_LENGTH = 64
const MAX_STATS_METADATA_VALUE_LENGTH = 2048
const commonSemverRegex = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

function isDevicePlatformValue(value: unknown): value is DevicePlatform {
  return value === 'ios' || value === 'android' || value === 'electron'
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fieldIssue(path: string, message: string): ValidationIssue {
  return makeIssue(message, [path])
}

function validateRequiredString(
  input: UnknownRecord,
  key: string,
  issues: ValidationIssue[],
  missingMessage: string,
  nonStringMessage: string,
): string | undefined {
  const value = input[key]
  if (value === undefined) {
    issues.push(fieldIssue(key, missingMessage))
    return undefined
  }
  if (typeof value !== 'string') {
    issues.push(fieldIssue(key, nonStringMessage))
    return undefined
  }
  return value
}

function validateRequiredBoolean(input: UnknownRecord, key: string, issues: ValidationIssue[]): boolean | undefined {
  const value = input[key]
  if (typeof value !== 'boolean') {
    issues.push(fieldIssue(key, `${key} must be a boolean`))
    return undefined
  }
  return value
}

function validateOptionalString(input: UnknownRecord, key: string, issues: ValidationIssue[]): string | undefined {
  const value = input[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    issues.push(fieldIssue(key, `${key} must be a string`))
    return undefined
  }
  return value
}

function validateOptionalStringMaxLength(
  input: UnknownRecord,
  key: string,
  maxLength: number,
  issues: ValidationIssue[],
): string | undefined {
  const value = validateOptionalString(input, key, issues)
  if (value === undefined) {
    return undefined
  }
  if (value.length > maxLength) {
    issues.push(fieldIssue(key, `String must contain at most ${maxLength} character(s)`))
    return undefined
  }
  return value
}

function validateInstallSourceValue(value: unknown, issues: ValidationIssue[]) {
  if (typeof value !== 'string') {
    issues.push(fieldIssue('install_source', 'install_source must be a string'))
    return
  }
  if (value.length > 64)
    issues.push(fieldIssue('install_source', 'String must contain at most 64 character(s)'))
}

function validateRequiredAppId(input: UnknownRecord, issues: ValidationIssue[]): string | undefined {
  const value = validateRequiredString(input, 'app_id', issues, MISSING_STRING_APP_ID, NON_STRING_APP_ID)
  if (value === undefined) {
    return undefined
  }
  if (!reverseDomainRegex.test(value)) {
    issues.push(fieldIssue('app_id', INVALID_STRING_APP_ID))
    return undefined
  }
  return value
}

function validateRequiredDeviceId(input: UnknownRecord, issues: ValidationIssue[]): string | undefined {
  const value = validateRequiredString(input, 'device_id', issues, MISSING_STRING_DEVICE_ID, NON_STRING_DEVICE_ID)
  if (value === undefined) {
    return undefined
  }
  if (value.length > 36) {
    issues.push(fieldIssue('device_id', 'String must contain at most 36 character(s)'))
    return undefined
  }
  if (!deviceIdRegex.test(value)) {
    issues.push(fieldIssue('device_id', INVALID_STRING_DEVICE_ID))
    return undefined
  }
  return value
}

function validateRequiredVersionName(input: UnknownRecord, issues: ValidationIssue[], allowEmpty = false): string | undefined {
  const value = validateRequiredString(input, 'version_name', issues, MISSING_STRING_VERSION_NAME, NON_STRING_VERSION_NAME)
  if (value === undefined) {
    return undefined
  }
  if (!allowEmpty && value.length === 0) {
    issues.push(fieldIssue('version_name', MISSING_STRING_VERSION_NAME))
    return undefined
  }
  return value
}

function validateRequiredVersionBuild(input: UnknownRecord, issues: ValidationIssue[], allowEmpty = false): string | undefined {
  const value = validateRequiredString(input, 'version_build', issues, MISSING_STRING_VERSION_BUILD, NON_STRING_VERSION_BUILD)
  if (value === undefined) {
    return undefined
  }
  if (!allowEmpty && value.length === 0) {
    issues.push(fieldIssue('version_build', MISSING_STRING_VERSION_BUILD))
    return undefined
  }
  return value
}

function validateRequiredVersionOs(input: UnknownRecord, issues: ValidationIssue[]): string | undefined {
  return validateRequiredString(input, 'version_os', issues, MISSING_STRING_VERSION_OS, NON_STRING_VERSION_OS)
}

function validateRequiredPlatformString(input: UnknownRecord, issues: ValidationIssue[]): string | undefined {
  return validateRequiredString(input, 'platform', issues, MISSING_STRING_PLATFORM, NON_STRING_PLATFORM)
}

function validateRequiredDevicePlatform(input: UnknownRecord, issues: ValidationIssue[]): DevicePlatform | undefined {
  const value = input.platform
  if (value === undefined) {
    issues.push(fieldIssue('platform', MISSING_STRING_PLATFORM))
    return undefined
  }
  if (!isDevicePlatformValue(value)) {
    issues.push(fieldIssue('platform', INVALID_STRING_PLATFORM))
    return undefined
  }
  return value
}

function validateRequiredPluginVersion(input: UnknownRecord, issues: ValidationIssue[]): string | undefined {
  const value = input.plugin_version
  if (value === undefined) {
    issues.push(fieldIssue('plugin_version', MISSING_STRING_PLUGIN_VERSION))
    return undefined
  }
  if (typeof value !== 'string' || (!commonSemverRegex.test(value) && !canParse(value))) {
    issues.push(fieldIssue('plugin_version', INVALID_STRING_PLUGIN_VERSION))
    return undefined
  }
  return value
}

function validateOptionalAction(input: UnknownRecord, issues: ValidationIssue[]): string | undefined {
  const value = input.action
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    issues.push(fieldIssue('action', 'action must be a string'))
    return undefined
  }
  if (!ALLOWED_STATS_ACTIONS_SET.has(value)) {
    issues.push(fieldIssue('action', `action must be one of: ${getAllowedStatsActionsList()}`))
    return undefined
  }
  return value
}

function validateOptionalStatsMetadata(input: UnknownRecord, issues: ValidationIssue[]) {
  const metadata = input.metadata
  if (metadata === undefined) {
    return
  }
  if (!isRecord(metadata)) {
    issues.push(fieldIssue('metadata', 'metadata must be an object with string values'))
    return
  }

  const entries = Object.entries(metadata)
  if (entries.length > MAX_STATS_METADATA_FIELDS) {
    issues.push(fieldIssue('metadata', `metadata must contain at most ${MAX_STATS_METADATA_FIELDS} fields`))
    return
  }

  for (const [key, value] of entries) {
    if (key.length > MAX_STATS_METADATA_KEY_LENGTH) {
      issues.push(fieldIssue(`metadata.${key}`, `metadata keys must contain at most ${MAX_STATS_METADATA_KEY_LENGTH} characters`))
      continue
    }
    if (typeof value !== 'string') {
      issues.push(fieldIssue(`metadata.${key}`, 'metadata values must be strings'))
      continue
    }
    if (value.length > MAX_STATS_METADATA_VALUE_LENGTH) {
      issues.push(fieldIssue(`metadata.${key}`, `metadata values must contain at most ${MAX_STATS_METADATA_VALUE_LENGTH} characters`))
    }
  }
}

function validateBasePluginBooleans(input: UnknownRecord, issues: ValidationIssue[]) {
  validateRequiredBoolean(input, 'is_emulator', issues)
  validateRequiredBoolean(input, 'is_prod', issues)
}

function validateOptionalCommonStrings(input: UnknownRecord, issues: ValidationIssue[]) {
  validateOptionalString(input, 'defaultChannel', issues)
  validateOptionalString(input, 'channel', issues)
  validateOptionalString(input, 'old_version_name', issues)
  validateOptionalString(input, 'version_code', issues)
  validateOptionalString(input, 'plugin_version', issues)
  if (input.install_source !== undefined)
    validateInstallSourceValue(input.install_source, issues)
  validateOptionalStringMaxLength(input, 'custom_id', 36, issues)
  validateOptionalStringMaxLength(input, 'key_id', 20, issues)
}

function createPluginSchema<T>(
  validateFields: (input: UnknownRecord, issues: ValidationIssue[]) => void,
  fastIs?: (value: unknown) => value is T,
): StandardSchema<T> {
  const validateHandrolled = (value: unknown) => {
    if (!isRecord(value)) {
      return { issues: [makeIssue('Expected object')] }
    }

    const issues: ValidationIssue[] = []
    validateFields(value, issues)

    if (issues.length > 0) {
      return { issues }
    }

    return { value: value as T }
  }

  // Specialize the success fast path at schema creation time so schemas without
  // a predicate don't pay for an optional call on every request.
  if (!fastIs)
    return createSchema<T>(validateHandrolled)

  return createSchema<T>((value) => {
    // AOT-style boolean predicate (zod-compiler / hand-extracted .is): much less
    // CPU than the handrolled issue builder on valid bodies. On miss, fall through
    // so existing error messages/behavior stay unchanged.
    if (fastIs(value))
      return { value }
    return validateHandrolled(value)
  })
}

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return isDevicePlatformValue(value)
}

export const updateRequestSchema = createPluginSchema<AppInfos>((input, issues) => {
  validateRequiredAppId(input, issues)
  validateRequiredDeviceId(input, issues)
  validateRequiredVersionName(input, issues)
  validateRequiredVersionBuild(input, issues)
  validateBasePluginBooleans(input, issues)
  validateRequiredDevicePlatform(input, issues)
  validateRequiredPluginVersion(input, issues)
  validateOptionalString(input, 'defaultChannel', issues)
  if (input.install_source !== undefined)
    validateInstallSourceValue(input.install_source, issues)
  validateOptionalStringMaxLength(input, 'key_id', 20, issues)
}, isUpdateRequestBody as (value: unknown) => value is AppInfos)

export const statsRequestSchema = createPluginSchema<AppStats>((input, issues) => {
  validateRequiredAppId(input, issues)
  validateRequiredDeviceId(input, issues)
  validateRequiredPlatformString(input, issues)
  validateRequiredVersionName(input, issues, true)
  validateRequiredVersionOs(input, issues)
  validateBasePluginBooleans(input, issues)
  validateOptionalCommonStrings(input, issues)
  validateOptionalAction(input, issues)
  validateOptionalStatsMetadata(input, issues)
  validateOptionalString(input, 'version_build', issues)
}, isStatsRequestBody as (value: unknown) => value is AppStats)

export const channelSelfRequestSchema = createPluginSchema<AppInfos>((input, issues) => {
  validateRequiredAppId(input, issues)
  validateRequiredDeviceId(input, issues)
  validateRequiredVersionName(input, issues, true)
  validateRequiredVersionBuild(input, issues, true)
  validateBasePluginBooleans(input, issues)
  validateRequiredDevicePlatform(input, issues)
  validateOptionalString(input, 'defaultChannel', issues)
  validateOptionalString(input, 'channel', issues)
  validateOptionalString(input, 'plugin_version', issues)
  if (input.install_source !== undefined)
    validateInstallSourceValue(input.install_source, issues)
  validateOptionalStringMaxLength(input, 'key_id', 20, issues)
}, isChannelSelfRequestBody as (value: unknown) => value is AppInfos)

export const channelSelfGetRequestSchema = createPluginSchema<{
  app_id: string
  is_emulator: boolean
  is_prod: boolean
  platform: DevicePlatform
  key_id?: string
}>((input, issues) => {
  validateRequiredAppId(input, issues)
  validateBasePluginBooleans(input, issues)
  validateRequiredDevicePlatform(input, issues)
  validateOptionalStringMaxLength(input, 'key_id', 20, issues)
})
