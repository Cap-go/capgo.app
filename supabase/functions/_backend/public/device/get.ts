import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import type { DeviceRes } from '../../utils/types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import type { RlsPrincipal } from '../../utils/pg_rls.ts'
import { cloudlog } from '../../utils/logging.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { apikeyPrincipal, queryJson, withRlsTransaction } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { readDevices } from '../../utils/stats.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

interface GetDevice {
  app_id: string
  device_id?: string
  /** Exact custom_id match (trimmed). Returns the paginated list shape. */
  custom_id?: string | null
  customIdMode?: boolean
  /** Cursor for pagination - pass nextCursor from previous response */
  cursor?: string
  /** Limit for results (default uses fetchLimit) */
  limit?: number
  /** ISO timestamp - only return devices with updated_at greater than this value */
  updated_at?: string
  /** Sort devices by updated_at: asc or desc */
  order?: string
}

interface publicDevice {
  updated_at: string
  device_id: string
  custom_id: string
  is_prod: boolean
  is_emulator: boolean
  install_source: string | null
  version_name: string | null
  app_id: string
  platform: Database['public']['Enums']['platform_os']
  plugin_version: string
  os_version: string
  version_build: string
  key_id: string | null
  country_code: string | null
  version?: number
  channel?: string
}

function toPublicUpdatedAt(value: string): string {
  // Cloudflare Analytics Engine returns UTC as "YYYY-MM-DD HH:mm:ss".
  const cloudflareUtc = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value)
  const normalized = cloudflareUtc ? `${cloudflareUtc[1]}T${cloudflareUtc[2]}.000Z` : value
  return new Date(normalized).toISOString()
}

function parseUpdatedAtFilter(updatedAt: string | undefined): string | undefined {
  if (!updatedAt)
    return undefined

  // Accept ISO-8601 UTC (Z) and the Cloudflare device timestamp format for sync round-trips.
  const cloudflareUtc = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(updatedAt)
  const normalized = cloudflareUtc
    ? `${cloudflareUtc[1]}-${cloudflareUtc[2]}-${cloudflareUtc[3]}T${cloudflareUtc[4]}:${cloudflareUtc[5]}:${cloudflareUtc[6]}.000Z`
    : updatedAt

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(normalized)
  if (!match) {
    throw simpleError('invalid_updated_at', 'updated_at must be a valid ISO date', { updated_at: updatedAt })
  }

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime()))
    throw simpleError('invalid_updated_at', 'updated_at must be a valid ISO date', { updated_at: updatedAt })

  const [, year, month, day, hour, minute, second] = match
  if (
    parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)
    || parsed.getUTCHours() !== Number(hour)
    || parsed.getUTCMinutes() !== Number(minute)
    || parsed.getUTCSeconds() !== Number(second)
  ) {
    throw simpleError('invalid_updated_at', 'updated_at must be a valid ISO date', { updated_at: updatedAt })
  }

  return parsed.toISOString()
}

function parseDevicesOrder(order: string | undefined) {
  if (!order)
    return undefined
  if (order !== 'asc' && order !== 'desc')
    throw simpleError('invalid_order', 'order must be asc or desc', { order })
  return [{ key: 'updated_at', sortable: order as 'asc' | 'desc' }]
}

export function parseCustomIdFilter(customId: string | null | undefined): string | undefined {
  // Only omit when the query/body field is absent. Explicit null must fail validation.
  if (customId === undefined)
    return undefined
  if (typeof customId !== 'string')
    throw simpleError('invalid_custom_id', 'custom_id must be a string', { custom_id: customId })

  const trimmed = customId.trim()
  if (!trimmed)
    throw simpleError('invalid_custom_id', 'custom_id must not be empty', { custom_id: customId })
  if (trimmed.length > 36)
    throw simpleError('invalid_custom_id', 'custom_id must be at most 36 characters', { custom_id: customId })

  return trimmed
}

type CallerRead = <T>(text: string, values: unknown[]) => Promise<T[] | null>

// Each read is its own RLS transaction on one connection (like one PostgREST request each), so a
// failed lookup is ignored on its own instead of aborting the next one.
async function withCallerReads<T>(c: Context, principal: RlsPrincipal, run: (read: CallerRead) => Promise<T>): Promise<T> {
  const pg = await getPgClient(c)
  try {
    return await run(async <R>(text: string, values: unknown[]) => {
      try {
        return await withRlsTransaction(pg, principal, client => queryJson<R>(client, text, values))
      }
      catch (error) {
        cloudlog({ requestId: c.get('requestId'), message: 'device lookup failed', error })
        return null
      }
    })
  }
  finally {
    closeClient(c, pg)
  }
}

export function filterDeviceKeys(devices: DeviceRes[]) {
  return devices.map((device) => {
    const { updated_at, device_id, custom_id, is_prod, is_emulator, install_source, version_name, version, app_id, platform, plugin_version, os_version, version_build, key_id, country_code } = device
    return {
      updated_at: updated_at ? toPublicUpdatedAt(updated_at) : updated_at,
      device_id,
      custom_id,
      is_prod,
      is_emulator,
      install_source,
      version_name,
      version,
      app_id,
      platform,
      plugin_version,
      os_version,
      version_build,
      key_id,
      country_code,
    }
  })
}

export async function get(c: Context, body: GetDevice, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }

  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.read_devices', { appId: body.app_id }))) {
    throw simpleError('cannot_access_app', 'You can\'t access this app', { app_id: body.app_id })
  }

  // if device_id get one device
  if (body.device_id) {
    const res = await readDevices(c, {
      app_id: body.app_id,
      deviceIds: [body.device_id.toLowerCase()],
      limit: 1,
    }, body.customIdMode ?? false)
    cloudlog({ requestId: c.get('requestId'), message: 'res', res })

    if (!res?.data?.length) {
      throw quickError(404, 'device_not_found', 'Cannot find device', { device_id: body.device_id })
    }
    const dataDevice = filterDeviceKeys(res.data)[0] as publicDevice
    const deviceId = body.device_id.toLowerCase()
    await withCallerReads(c, apikeyPrincipal(c, apikey.key), async (read) => {
      if (dataDevice.version_name && !res.data[0].version) {
        const dataVersion = await read<{ id: number, name: string }>(
          'SELECT id, name FROM public.app_versions WHERE app_id = $1 AND name = $2 LIMIT 2',
          [body.app_id, dataDevice.version_name],
        )
        if (dataVersion?.length === 1)
          dataDevice.version = dataVersion[0].id
      }

      // Check for channel override
      const channelOverride = await read<{ channel_id: number, channels: { name: string } | null }>(
        `SELECT cd.channel_id, (SELECT pg_catalog.json_build_object('name', ch.name) FROM public.channels ch WHERE ch.id = cd.channel_id) AS channels
         FROM public.channel_devices cd
         WHERE cd.device_id = $1 AND cd.app_id = $2
         LIMIT 2`,
        [deviceId, body.app_id],
      )

      if (channelOverride?.length === 1 && channelOverride[0].channels) {
        dataDevice.channel = channelOverride[0].channels.name
      }
    })

    return c.json(dataDevice)
  }
  else {
    const customIdFilter = parseCustomIdFilter(body.custom_id)
    const updatedAtGt = parseUpdatedAtFilter(body.updated_at)
    const order = parseDevicesOrder(body.order)
    const limit = body.limit == null ? fetchLimit : Number(body.limit)
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
      throw simpleError('invalid_limit', 'limit must be a positive integer', { limit: body.limit })
    }

    const res = await readDevices(c, {
      app_id: body.app_id,
      customIds: customIdFilter ? [customIdFilter] : undefined,
      cursor: body.cursor,
      limit,
      updated_at_gt: updatedAtGt,
      order,
    }, body.customIdMode ?? false)

    if (!res?.data) {
      throw quickError(404, 'devices_not_found', 'Cannot get devices')
    }
    const dataDevices = filterDeviceKeys(res.data) as publicDevice[]
    // get versions from all devices
    const versionNames = [...new Set(dataDevices.map(device => device.version_name).filter(Boolean).filter(v => v !== null && v !== undefined))]
    const versionIds = [...new Set(dataDevices.map(device => device.version).filter(Boolean).filter(v => v !== null && v !== undefined))] as number[]
    await withCallerReads(c, apikeyPrincipal(c, apikey.key), async (read) => {
      let versionMap: Record<string, { id: number, name: string }> = {}
      if (versionNames.length) {
        const dataVersions = await read<{ id: number, name: string }>(
          'SELECT id, name FROM public.app_versions WHERE app_id = $1 AND name = ANY($2::text[])',
          [body.app_id, versionNames],
        )
        if (dataVersions?.length) {
          versionMap = dataVersions.reduce((acc, version) => {
            acc[version.name] = version
            return acc
          }, {} as Record<string, { id: number, name: string }>)
        }
      }
      const missingVersionIds = versionIds.filter(id => !Object.values(versionMap).some(v => v.id === id))
      if (missingVersionIds.length) {
        const dataVersions = await read<{ id: number, name: string }>(
          'SELECT id, name FROM public.app_versions WHERE app_id = $1 AND id = ANY($2::bigint[])',
          [body.app_id, missingVersionIds],
        )
        if (dataVersions?.length) {
          versionMap = dataVersions.reduce((acc, version) => {
            acc[version.name] = version
            return acc
          }, versionMap)
        }
      }
      dataDevices.forEach((device) => {
        const versionName = device.version_name
        const version = versionName ? versionMap[versionName] : undefined
        if (version)
          device.version = version.id
      })

      // Get channel overrides for all devices
      const deviceIds = dataDevices.map(device => device.device_id.toLowerCase())
      const channelOverrides = await read<{ device_id: string, channel_id: number, channels: { name: string } | null }>(
        `SELECT cd.device_id, cd.channel_id, (SELECT pg_catalog.json_build_object('name', ch.name) FROM public.channels ch WHERE ch.id = cd.channel_id) AS channels
         FROM public.channel_devices cd
         WHERE cd.device_id = ANY($1::text[]) AND cd.app_id = $2`,
        [deviceIds, body.app_id],
      )

      // Add channel override to each device that has one
      if (channelOverrides?.length) {
        dataDevices.forEach((device) => {
          const override = channelOverrides.find(o => o.device_id === device.device_id.toLowerCase())
          if (override?.channels) {
            (device as any).channel = override.channels.name
          }
        })
      }
    })

    return c.json({
      data: dataDevices,
      nextCursor: res.nextCursor,
      hasMore: res.hasMore,
    })
  }
}
