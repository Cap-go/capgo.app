import type { Context } from 'hono'
import type { ChannelImpactDeviceGroup, ChannelImpactPlatform } from './channel_impact.ts'
import type { ChannelDeviceOverrideIds } from './types.ts'
import { CHANNEL_IMPACT_WINDOW_DAYS } from './channel_impact.ts'
import { buildDeviceChannelScopeCF, escapeSqlString, formatDateCF, runQueryToCFA } from './cloudflare.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'

/**
 * Distinct device setups of one channel (effective channel: reported
 * default_channel, public-default fallback and forced overrides), active in the
 * last CHANNEL_IMPACT_WINDOW_DAYS days. One row per setup, largest first.
 */
export const CHANNEL_IMPACT_MAX_GROUPS = 500

export interface ChannelDevicePopulation {
  groups: ChannelImpactDeviceGroup[]
  /** Devices in scope; can exceed the sum of `groups` when the setup list was capped. */
  total_devices: number
  truncated: boolean
}

interface PopulationRowCF {
  platform: number | string
  version_build: string
  version_name: string
  plugin_version: string
  is_prod: number | string
  is_emulator: number | string
  device_count: number | string
  sample_device_id: string
  latest_seen: string
}

/** Cutoff rounded down to the minute so repeated reads share the same SQL text. */
export function channelImpactWindowStart(now = Date.now()) {
  const start = now - CHANNEL_IMPACT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  return new Date(Math.floor(start / 60_000) * 60_000)
}

function platformFromCF(value: number | string | null | undefined): ChannelImpactPlatform {
  const platform = Number(value)
  if (platform === 1)
    return 'ios'
  if (platform === 0)
    return 'android'
  if (platform === 2)
    return 'electron'
  return 'unknown'
}

function flagFromCF(value: number | string | null | undefined): boolean | null {
  const flag = Number(value)
  if (flag === 1)
    return true
  if (flag === 0)
    return false
  return null
}

/** Analytics Engine returns UTC "YYYY-MM-DD HH:MM:SS" timestamps. */
function isoFromCF(value: string | null | undefined): string | null {
  if (!value)
    return null
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function deviceScopeInnerCF(appId: string, windowStart: Date) {
  // Schema: blob1=device_id, blob2=version_name, blob3=plugin_version, blob6=version_build,
  //         blob7=default_channel, double1=platform, double2=is_prod, double3=is_emulator
  return `SELECT
    blob1 AS device_id,
    argMax(blob2, timestamp) AS version_name,
    argMax(blob3, timestamp) AS plugin_version,
    argMax(blob6, timestamp) AS version_build,
    argMax(blob7, timestamp) AS default_channel,
    argMax(double1, timestamp) AS platform,
    argMax(double2, timestamp) AS is_prod,
    argMax(double3, timestamp) AS is_emulator,
    max(timestamp) AS last_seen
  FROM device_info
  WHERE index1 = '${escapeSqlString(appId)}' AND timestamp > toDateTime('${escapeSqlString(formatDateCF(windowStart))}')
  GROUP BY blob1`
}

export function buildChannelPopulationCFQuery(appId: string, channelName: string, overrides: ChannelDeviceOverrideIds | undefined, windowStart: Date, limit = CHANNEL_IMPACT_MAX_GROUPS) {
  return `SELECT
  platform,
  version_build,
  version_name,
  plugin_version,
  is_prod,
  is_emulator,
  count() AS device_count,
  argMax(device_id, last_seen) AS sample_device_id,
  max(last_seen) AS latest_seen
FROM (
  ${deviceScopeInnerCF(appId, windowStart)}
)
WHERE ${buildDeviceChannelScopeCF(channelName, overrides)}
GROUP BY platform, version_build, version_name, plugin_version, is_prod, is_emulator
ORDER BY device_count DESC
LIMIT ${Math.max(1, Math.floor(limit))}`
}

export function buildChannelPopulationCountCFQuery(appId: string, channelName: string, overrides: ChannelDeviceOverrideIds | undefined, windowStart: Date) {
  return `SELECT count() AS total
FROM (
  ${deviceScopeInnerCF(appId, windowStart)}
)
WHERE ${buildDeviceChannelScopeCF(channelName, overrides)}`
}

export function toPopulationGroupsCF(rows: PopulationRowCF[]): ChannelImpactDeviceGroup[] {
  return rows.map(row => ({
    platform: platformFromCF(row.platform),
    version_build: row.version_build ?? '',
    version_name: row.version_name ?? '',
    plugin_version: row.plugin_version ?? '',
    is_prod: flagFromCF(row.is_prod),
    is_emulator: flagFromCF(row.is_emulator),
    device_count: Number(row.device_count) || 0,
    sample_device_id: row.sample_device_id ?? '',
    last_seen: isoFromCF(row.latest_seen),
  }))
}

function sumDevices(groups: ChannelImpactDeviceGroup[]) {
  return groups.reduce((sum, group) => sum + group.device_count, 0)
}

export async function readChannelDevicePopulationCF(c: Context, appId: string, channelName: string, overrides?: ChannelDeviceOverrideIds): Promise<ChannelDevicePopulation> {
  const windowStart = channelImpactWindowStart()
  const query = buildChannelPopulationCFQuery(appId, channelName, overrides, windowStart)
  try {
    const groups = toPopulationGroupsCF(await runQueryToCFA<PopulationRowCF>(c, query))
    if (groups.length < CHANNEL_IMPACT_MAX_GROUPS)
      return { groups, total_devices: sumDevices(groups), truncated: false }
    // Only a capped setup list needs the exact device count.
    const [count] = await runQueryToCFA<{ total: number | string }>(c, buildChannelPopulationCountCFQuery(appId, channelName, overrides, windowStart))
    return { groups, total_devices: Math.max(sumDevices(groups), Number(count?.total) || 0), truncated: true }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading channel device population from Analytics Engine', error: serializeError(error) })
    throw error
  }
}

interface PopulationRowSB {
  platform: string | null
  version_build: string | null
  version_name: string | null
  plugin_version: string | null
  is_prod: boolean | null
  is_emulator: boolean | null
  device_count: number | string
  sample_device_id: string | null
  last_seen: string | Date | null
}

/** Same population from public.devices (self-host, local and test runtimes without Analytics Engine). */
export async function readChannelDevicePopulationSB(c: Context, appId: string, channelName: string, overrides?: ChannelDeviceOverrideIds): Promise<ChannelDevicePopulation> {
  const windowStart = channelImpactWindowStart()
  const defaultPlatforms = overrides?.defaultForPlatforms ?? []
  const elsewhere = overrides?.elsewhere ?? []
  const into = overrides?.into ?? []
  const pg = await getPgClient(c)
  try {
    const { rows } = await pg.query<PopulationRowSB>(
      `SELECT
        d.platform::text AS platform,
        COALESCE(d.version_build, '') AS version_build,
        d.version_name,
        d.plugin_version,
        d.is_prod,
        d.is_emulator,
        count(*)::int AS device_count,
        (array_agg(d.device_id ORDER BY d.updated_at DESC))[1] AS sample_device_id,
        max(d.updated_at) AS last_seen
      FROM public.devices d
      WHERE d.app_id = $1
        AND d.updated_at > $2::timestamptz
        AND (
          (
            (d.default_channel = $3 OR ((d.default_channel IS NULL OR d.default_channel = '') AND d.platform::text = ANY($4::text[])))
            AND NOT (lower(d.device_id) = ANY($5::text[]))
          )
          OR lower(d.device_id) = ANY($6::text[])
        )
      GROUP BY 1, 2, 3, 4, 5, 6
      ORDER BY device_count DESC
      LIMIT $7`,
      [appId, windowStart.toISOString(), channelName, defaultPlatforms, elsewhere, into, CHANNEL_IMPACT_MAX_GROUPS],
    )
    const groups = rows.map(row => ({
      platform: (['ios', 'android', 'electron'].includes(row.platform ?? '') ? row.platform : 'unknown') as ChannelImpactPlatform,
      version_build: row.version_build ?? '',
      version_name: row.version_name ?? '',
      plugin_version: row.plugin_version ?? '',
      is_prod: row.is_prod,
      is_emulator: row.is_emulator,
      device_count: Number(row.device_count) || 0,
      sample_device_id: row.sample_device_id ?? '',
      last_seen: row.last_seen ? new Date(row.last_seen).toISOString() : null,
    }))
    const truncated = groups.length >= CHANNEL_IMPACT_MAX_GROUPS
    if (!truncated)
      return { groups, total_devices: sumDevices(groups), truncated }
    const { rows: [count] } = await pg.query<{ total: number | string }>(
      `SELECT count(*)::int AS total
      FROM public.devices d
      WHERE d.app_id = $1
        AND d.updated_at > $2::timestamptz
        AND (
          (
            (d.default_channel = $3 OR ((d.default_channel IS NULL OR d.default_channel = '') AND d.platform::text = ANY($4::text[])))
            AND NOT (lower(d.device_id) = ANY($5::text[]))
          )
          OR lower(d.device_id) = ANY($6::text[])
        )`,
      [appId, windowStart.toISOString(), channelName, defaultPlatforms, elsewhere, into],
    )
    return { groups, total_devices: Math.max(sumDevices(groups), Number(count?.total) || 0), truncated }
  }
  finally {
    closeClient(c, pg)
  }
}
