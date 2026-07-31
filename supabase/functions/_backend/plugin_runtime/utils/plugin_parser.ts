import type { Context } from 'hono'
import type { StandardSchema } from './schema_validation.ts'
import type { Database } from './supabase.types.ts'
import type { AppInfos, AppStats, DeviceWithoutCreatedAt } from './types.ts'
import { format, tryParse } from '@std/semver'
import { fixSemver } from '../utils/utils.ts'
import { safeParseSchema } from './schema_validation.ts'
import { simpleError } from './hono.ts'

export interface DeviceLink extends AppInfos {
  channel?: string
}

function normalizeCustomId(customId: unknown): string | undefined {
  if (typeof customId !== 'string')
    return undefined
  const trimmed = customId.trim()
  return trimmed === '' ? undefined : trimmed
}

function normalizeInstallSource(installSource: unknown): string | undefined {
  if (typeof installSource !== 'string')
    return undefined
  const trimmed = installSource.trim().toLowerCase()
  return trimmed === '' ? undefined : trimmed
}

function getInvalidCode(c: Context) {
  return c.req.method === 'GET' || c.req.method === 'DELETE' ? 'invalid_query_parameters' : 'invalid_json_body'
}

const commonSemverRegex = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

export function makeDevice(devBody: AppInfos | DeviceLink | AppStats, allowCustomID = true): DeviceWithoutCreatedAt {
  const normalizedCustomId = normalizeCustomId(devBody.custom_id)
  const customId = allowCustomID ? normalizedCustomId : undefined
  const device = {
    platform: devBody.platform as Database['public']['Enums']['platform_os'],
    device_id: devBody.device_id,
    app_id: devBody.app_id,
    plugin_version: devBody.plugin_version,
    version_build: devBody.version_build,
    os_version: devBody.version_os,
    version_name: devBody.version_name,
    is_emulator: devBody.is_emulator ?? false,
    is_prod: devBody.is_prod ?? true,
    install_source: normalizeInstallSource(devBody.install_source),
    custom_id: customId,
    updated_at: new Date().toISOString(),
    default_channel: devBody.defaultChannel ?? null,
    key_id: devBody.key_id ?? null,
  } as DeviceWithoutCreatedAt
  return device
}

export function parsePluginBody<T extends AppInfos | DeviceLink | AppStats>(c: Context, body: T, schema: StandardSchema<T>, requireDevice = true) {
  if (!body || (body.app_id === undefined && body.device_id === undefined && Object.keys(body).length === 0)) {
    throw simpleError(getInvalidCode(c), 'Cannot parse body', { body })
  }
  if (requireDevice && !body.device_id) {
    throw simpleError('missing_device_id', 'Cannot find device_id', { body })
  }
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Cannot find app_id', { body })
  }
  // Only validate version_build if it's provided (not required for GET /channel_self)
  if (body.version_build && !commonSemverRegex.test(body.version_build)) {
    const coerce = tryParse(fixSemver(body.version_build))
    if (!coerce) {
      throw simpleError('semver_error', `Native version: ${body.version_build} doesn't follow semver convention, please check https://capgo.app/semver_tester/ to learn more about semver usage in Capgo`, { version_build: body.version_build })
    }
    body.version_build = format(coerce)
  }
  // For plugin below 5.0.0, we need to set the default values of is_emulator and is_prod
  body.is_emulator ??= false
  body.is_prod ??= true
  if (body.version_name) {
    body.version_name = (body.version_name === 'builtin' || !body.version_name) ? body.version_build : body.version_name
  }
  const parseResult = safeParseSchema(schema, body)
  if (!parseResult.success) {
    throw simpleError(getInvalidCode(c), 'Cannot parse body', { parseResult })
  }
  return parseResult.data
}

export function convertQueryToBody(query: Record<string, string>): DeviceLink {
  if (!Object.keys(query).length) {
    return {} as DeviceLink
  }
  // For plugin below 5.0.0, we need to set the default values of is_emulator and is_prod
  query.is_emulator ??= 'false'
  query.is_prod ??= 'true'
  // Ensure the device_id is lowercase for compatibility with old plugins below 7.0.0
  query.device_id = query.device_id?.toLowerCase()
  const body = {
    version_name: query.version_name,
    version_build: query.version_build,
    platform: query.platform,
    app_id: query.app_id,
    device_id: query.device_id,
    plugin_version: query.plugin_version,
    defaultChannel: query.defaultChannel,
    channel: query.channel,
    custom_id: query.custom_id,
    is_emulator: query.is_emulator === 'true',
    is_prod: query.is_prod === 'true',
    install_source: query.install_source,
    version_os: query.version_os,
    key_id: query.key_id,
  }
  return body
}
