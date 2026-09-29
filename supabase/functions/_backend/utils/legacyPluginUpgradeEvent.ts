import { CHANNEL_SELF_STORE_CUTOFF_CAPTION, isLegacyChannelSelfStorePluginVersion } from './plugin_compatibility.ts'

/** Bento event the plugin-upgrade email automation listens for. */
export const LEGACY_PLUGIN_UPGRADE_BENTO_EVENT = 'plugin:legacy_channel_upgrade'

/** Keep the Bento payload small when an org still has many old apps. */
export const LEGACY_PLUGIN_UPGRADE_APP_LIMIT = 10

/** One Bento event per email, even when that person admins several orgs. */
export const LEGACY_PLUGIN_UPGRADE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface PluginVersionDeviceRow {
  app_id: string
  plugin_version: string
  device_count: number
}

export interface LegacyPluginAppSummary {
  appId: string
  legacyDevices: number
  reportedDevices: number
  mainPluginVersion: string
}

export interface LegacyPluginOrgApp extends LegacyPluginAppSummary {
  ownerOrgId: string
}

export interface LegacyPluginUpgradeEvent {
  email: string
  event: typeof LEGACY_PLUGIN_UPGRADE_BENTO_EVENT
  details: {
    org_id: string
    app_count: number
    legacy_devices: number
    reported_devices: number
    main_plugin_version: string
    cutoff: string
    apps: Array<{
      app_id: string
      legacy_devices: number
      reported_devices: number
      main_plugin_version: string
    }>
  }
}

export function summarizeLegacyPluginApps(rows: readonly PluginVersionDeviceRow[], minLegacyDevices = 1): LegacyPluginAppSummary[] {
  const apps = new Map<string, { legacyDevices: number, reportedDevices: number, versions: Map<string, number> }>()

  for (const row of rows) {
    const deviceCount = Number(row.device_count) || 0
    if (!row.app_id || deviceCount <= 0)
      continue

    const app = apps.get(row.app_id) ?? { legacyDevices: 0, reportedDevices: 0, versions: new Map<string, number>() }
    app.reportedDevices += deviceCount
    if (isLegacyChannelSelfStorePluginVersion(row.plugin_version)) {
      app.legacyDevices += deviceCount
      app.versions.set(row.plugin_version, (app.versions.get(row.plugin_version) ?? 0) + deviceCount)
    }
    apps.set(row.app_id, app)
  }

  const summaries: LegacyPluginAppSummary[] = []
  for (const [appId, app] of apps) {
    if (app.legacyDevices < minLegacyDevices)
      continue

    let mainPluginVersion = ''
    let mainCount = -1
    for (const [version, count] of app.versions) {
      if (count > mainCount || (count === mainCount && version.localeCompare(mainPluginVersion) < 0)) {
        mainPluginVersion = version
        mainCount = count
      }
    }

    summaries.push({
      appId,
      legacyDevices: app.legacyDevices,
      reportedDevices: app.reportedDevices,
      mainPluginVersion,
    })
  }

  summaries.sort((left, right) => right.legacyDevices - left.legacyDevices || left.appId.localeCompare(right.appId))
  return summaries
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export function buildLegacyPluginUpgradeEvents(
  apps: readonly LegacyPluginOrgApp[],
  recipientsByOrg: ReadonlyMap<string, readonly string[]>,
): LegacyPluginUpgradeEvent[] {
  const appsByOrg = new Map<string, LegacyPluginOrgApp[]>()
  for (const app of apps) {
    const orgApps = appsByOrg.get(app.ownerOrgId) ?? []
    orgApps.push(app)
    appsByOrg.set(app.ownerOrgId, orgApps)
  }

  const events: LegacyPluginUpgradeEvent[] = []
  const orgIds = [...appsByOrg.keys()].sort()
  for (const orgId of orgIds) {
    const orgApps = appsByOrg.get(orgId) ?? []
    orgApps.sort((left, right) => right.legacyDevices - left.legacyDevices || left.appId.localeCompare(right.appId))
    const emails = new Set<string>()
    for (const email of recipientsByOrg.get(orgId) ?? []) {
      const normalized = normalizeEmail(email)
      if (normalized.includes('@'))
        emails.add(normalized)
    }

    const legacyDevices = orgApps.reduce((sum, app) => sum + app.legacyDevices, 0)
    const reportedDevices = orgApps.reduce((sum, app) => sum + app.reportedDevices, 0)
    const details = {
      org_id: orgId,
      app_count: orgApps.length,
      legacy_devices: legacyDevices,
      reported_devices: reportedDevices,
      main_plugin_version: orgApps[0]?.mainPluginVersion ?? '',
      cutoff: CHANNEL_SELF_STORE_CUTOFF_CAPTION,
      apps: orgApps.slice(0, LEGACY_PLUGIN_UPGRADE_APP_LIMIT).map(app => ({
        app_id: app.appId,
        legacy_devices: app.legacyDevices,
        reported_devices: app.reportedDevices,
        main_plugin_version: app.mainPluginVersion,
      })),
    }

    for (const email of [...emails].sort()) {
      events.push({
        email,
        event: LEGACY_PLUGIN_UPGRADE_BENTO_EVENT,
        details,
      })
    }
  }

  return events
}

export function isLegacyPluginUpgradeDue(lastSentAt: Date | string | null | undefined, now: Date) {
  if (lastSentAt == null || lastSentAt === '')
    return true
  const last = lastSentAt instanceof Date ? lastSentAt : new Date(lastSentAt)
  if (Number.isNaN(last.getTime()))
    return false
  return now.getTime() - last.getTime() >= LEGACY_PLUGIN_UPGRADE_MIN_INTERVAL_MS
}

/**
 * One event per email per 24 hours. When the same person admins several orgs,
 * keep the org with the most legacy devices.
 */
export function selectLegacyPluginUpgradeEventsForSend(
  events: readonly LegacyPluginUpgradeEvent[],
  lastSentAtByEmail: ReadonlyMap<string, Date | string>,
  now: Date,
): LegacyPluginUpgradeEvent[] {
  const ranked = [...events].sort((left, right) =>
    right.details.legacy_devices - left.details.legacy_devices
    || left.email.localeCompare(right.email)
    || left.details.org_id.localeCompare(right.details.org_id))

  const selected: LegacyPluginUpgradeEvent[] = []
  const seen = new Set<string>()
  for (const event of ranked) {
    if (seen.has(event.email))
      continue
    seen.add(event.email)
    if (!isLegacyPluginUpgradeDue(lastSentAtByEmail.get(event.email), now))
      continue
    selected.push(event)
  }
  return selected
}

export async function legacyPluginUpgradeRecipientId(email: string) {
  const data = new TextEncoder().encode(normalizeEmail(email))
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
