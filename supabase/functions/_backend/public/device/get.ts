import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import type { DeviceRes } from '../../utils/types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { readDevices } from '../../utils/stats.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

interface GetDevice {
  app_id: string
  device_id?: string
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
    if (dataDevice.version_name && !res.data[0].version) {
      const { data: dataVersion, error: dbErrorVersion } = await supabaseApikey(c, apikey.key)
        .from('app_versions')
        .select('id, name')
        .eq('app_id', body.app_id)
        .eq('name', dataDevice.version_name)
        .maybeSingle()
      if (!dbErrorVersion && dataVersion)
        dataDevice.version = dataVersion.id
    }

    // Check for channel override
    const { data: channelOverride } = await supabaseApikey(c, apikey.key)
      .from('channel_devices')
      .select(`
        channel_id,
        channels (
          name
        )
      `)
      .eq('device_id', body.device_id.toLowerCase())
      .eq('app_id', body.app_id)
      .single()

    if (channelOverride?.channels) {
      dataDevice.channel = channelOverride.channels.name
    }

    return c.json(dataDevice)
  }
  else {
    const updatedAtGt = parseUpdatedAtFilter(body.updated_at)
    const order = parseDevicesOrder(body.order)
    const limit = body.limit == null ? fetchLimit : Number(body.limit)
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
      throw simpleError('invalid_limit', 'limit must be a positive integer', { limit: body.limit })
    }

    const res = await readDevices(c, {
      app_id: body.app_id,
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
    let versionMap: Record<string, { id: number, name: string }> = {}
    if (versionNames.length) {
      const { data: dataVersions } = await supabaseApikey(c, apikey.key)
        .from('app_versions')
        .select('id, name')
        .eq('app_id', body.app_id)
        .in('name', versionNames)
      if (dataVersions?.length) {
        versionMap = dataVersions.reduce((acc, version) => {
          acc[version.name] = version as any
          return acc
        }, {} as Record<string, { id: number, name: string }>)
      }
    }
    const missingVersionIds = versionIds.filter(id => !Object.values(versionMap).some(v => v.id === id))
    if (missingVersionIds.length) {
      const { data: dataVersions } = await supabaseApikey(c, apikey.key)
        .from('app_versions')
        .select('id, name')
        .eq('app_id', body.app_id)
        .in('id', missingVersionIds)
      if (dataVersions?.length) {
        versionMap = dataVersions.reduce((acc, version) => {
          acc[version.name] = version as any
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
    const { data: channelOverrides } = await supabaseApikey(c, apikey.key)
      .from('channel_devices')
      .select(`
        device_id,
        channel_id,
        channels (
          name
        )
      `)
      .in('device_id', deviceIds)
      .eq('app_id', body.app_id)

    // Add channel override to each device that has one
    if (channelOverrides?.length) {
      dataDevices.forEach((device) => {
        const override = channelOverrides.find(o => o.device_id === device.device_id.toLowerCase())
        if (override?.channels) {
          (device as any).channel = override.channels.name
        }
      })
    }

    return c.json({
      data: dataDevices,
      nextCursor: res.nextCursor,
      hasMore: res.hasMore,
    })
  }
}
