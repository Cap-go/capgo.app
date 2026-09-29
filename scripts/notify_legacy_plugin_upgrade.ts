/*
 * Send one Bento event per org admin for apps still on the old channel plugin.
 *
 * The event is `plugin:legacy_channel_upgrade`. Create the Bento email automation
 * on that event before applying. This script does not send mail itself.
 * Each email is sent at most once per 24 hours. The last send is stored in
 * public.notifications, so a second run the same day sends nothing.
 *
 * Dry run:
 *   bun run admin:notify-legacy-plugin-upgrade
 *
 * Send:
 *   bun run admin:notify-legacy-plugin-upgrade -- --apply
 *
 * Options:
 *   --apply                     Send events. Without this, nothing is sent.
 *   --min-legacy-devices=N      Skip apps below this legacy device count. Default: 1.
 *   --env-file=PATH             Default: internal/cloudflare/.env.prod
 */
import process from 'node:process'
import { CHANNEL_SELF_STORE_CUTOFF_CAPTION } from '../supabase/functions/_backend/utils/plugin_compatibility.ts'
import {
  buildLegacyPluginUpgradeEvents,
  isLegacyPluginUpgradeDue,
  LEGACY_PLUGIN_UPGRADE_BENTO_EVENT,
  LEGACY_PLUGIN_UPGRADE_MIN_INTERVAL_MS,
  legacyPluginUpgradeClaimOrgId,
  legacyPluginUpgradeRecipientId,
  selectLegacyPluginUpgradeEventsForSend,
  summarizeLegacyPluginApps,
  type LegacyPluginUpgradeEvent,
} from '../supabase/functions/_backend/utils/legacyPluginUpgradeEvent.ts'
import { createSupabaseServiceClient, DEFAULT_ENV_FILE, getArgValue, getRequiredEnv, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const BENTO_BATCH_SIZE = 50
const NOTIFICATION_PAGE_SIZE = 1000
const QUERY_CHUNK = 100
const ADMIN_ROLE_NAMES = ['org_admin', 'org_super_admin']

interface PluginRow {
  app_id: string
  plugin_version: string
  device_count: number | string
}

function chunk<T>(items: readonly T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size))
  return chunks
}

async function runAnalyticsQuery(env: Record<string, string | undefined>, query: string) {
  const accountId = getRequiredEnv(env, 'CF_ACCOUNT_ANALYTICS_ID')
  const token = getRequiredEnv(env, 'CF_ANALYTICS_TOKEN')
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain; charset=utf-8',
      'User-Agent': 'Capgo/1.0',
    },
    body: query,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Cloudflare Analytics query failed (${response.status}): ${body.slice(0, 500)}`)
  }
  const payload = await response.json() as { data?: PluginRow[] }
  return payload.data ?? []
}

async function loadUpgradeNotifications(supabase: ReturnType<typeof createSupabaseServiceClient>) {
  const latestByRecipient = new Map<string, Date>()
  const lastSendAtByRecipientOrg = new Map<string, string>()
  for (let from = 0; ; from += NOTIFICATION_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('notifications')
      .select('owner_org, uniq_id, last_send_at')
      .eq('event', LEGACY_PLUGIN_UPGRADE_BENTO_EVENT)
      .order('uniq_id')
      .order('owner_org')
      .range(from, from + NOTIFICATION_PAGE_SIZE - 1)
    if (error)
      throw new Error(error.message)

    for (const row of data ?? []) {
      const sentAt = new Date(row.last_send_at)
      const previous = latestByRecipient.get(row.uniq_id)
      if (!previous || sentAt > previous)
        latestByRecipient.set(row.uniq_id, sentAt)
      lastSendAtByRecipientOrg.set(`${row.uniq_id}\n${row.owner_org}`, row.last_send_at)
    }
    if ((data ?? []).length < NOTIFICATION_PAGE_SIZE)
      break
  }
  return { latestByRecipient, lastSendAtByRecipientOrg }
}

interface SendClaim {
  event: LegacyPluginUpgradeEvent
  uniqId: string
  claimOrgId: string
  previousLastSendAt: string | null
}

class BentoBatchRejectedError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'BentoBatchRejectedError'
  }
}

async function claimEvents(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  events: readonly LegacyPluginUpgradeEvent[],
  lastSendAtByRecipientOrg: Map<string, string>,
  now: Date,
) {
  const claimed: SendClaim[] = []
  const nowIso = now.toISOString()
  const recentSince = new Date(now.getTime() - LEGACY_PLUGIN_UPGRADE_MIN_INTERVAL_MS).toISOString()
  for (const event of events) {
    const uniqId = await legacyPluginUpgradeRecipientId(event.email)
    const claimOrgId = legacyPluginUpgradeClaimOrgId(uniqId)
    const { data: recent, error: recentError } = await supabase
      .from('notifications')
      .select('uniq_id')
      .eq('event', LEGACY_PLUGIN_UPGRADE_BENTO_EVENT)
      .eq('uniq_id', uniqId)
      .gte('last_send_at', recentSince)
      .limit(1)
    if (recentError)
      throw new Error(recentError.message)
    if ((recent ?? []).length > 0)
      continue

    const claimKey = `${uniqId}\n${claimOrgId}`
    const previousLastSendAt = lastSendAtByRecipientOrg.get(claimKey) ?? null
    if (previousLastSendAt == null) {
      const { error } = await supabase.from('notifications').insert({
        owner_org: claimOrgId,
        event: LEGACY_PLUGIN_UPGRADE_BENTO_EVENT,
        uniq_id: uniqId,
        last_send_at: nowIso,
      })
      if (error) {
        if (error.code === '23505')
          continue
        throw new Error(error.message)
      }
    }
    else {
      const { data, error } = await supabase
        .from('notifications')
        .update({ last_send_at: nowIso })
        .eq('owner_org', claimOrgId)
        .eq('event', LEGACY_PLUGIN_UPGRADE_BENTO_EVENT)
        .eq('uniq_id', uniqId)
        .eq('last_send_at', previousLastSendAt)
        .select('uniq_id')
      if (error)
        throw new Error(error.message)
      if ((data ?? []).length === 0)
        continue
    }
    lastSendAtByRecipientOrg.set(claimKey, nowIso)
    claimed.push({ event, uniqId, claimOrgId, previousLastSendAt })
  }
  return claimed
}

async function rollbackClaims(supabase: ReturnType<typeof createSupabaseServiceClient>, claims: readonly SendClaim[]) {
  for (const claim of claims) {
    if (claim.previousLastSendAt == null) {
      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('owner_org', claim.claimOrgId)
        .eq('event', LEGACY_PLUGIN_UPGRADE_BENTO_EVENT)
        .eq('uniq_id', claim.uniqId)
      if (error)
        throw new Error(error.message)
      continue
    }
    const { error } = await supabase
      .from('notifications')
      .update({ last_send_at: claim.previousLastSendAt })
      .eq('owner_org', claim.claimOrgId)
      .eq('event', LEGACY_PLUGIN_UPGRADE_BENTO_EVENT)
      .eq('uniq_id', claim.uniqId)
    if (error)
      throw new Error(error.message)
  }
}

async function sendBentoBatch(env: Record<string, string | undefined>, events: Array<{ email: string, event: string, details: Record<string, unknown> }>) {
  const siteUuid = getRequiredEnv(env, 'BENTO_SITE_UUID')
  const publishableKey = getRequiredEnv(env, 'BENTO_PUBLISHABLE_KEY')
  const secretKey = getRequiredEnv(env, 'BENTO_SECRET_KEY')
  const response = await fetch(`https://app.bentonow.com/api/v1/batch/events?site_uuid=${encodeURIComponent(siteUuid)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${publishableKey}:${secretKey}`)}`,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'Capgo',
    },
    body: JSON.stringify({
      events: events.map(event => ({
        type: event.event,
        email: event.email,
        details: event.details,
      })),
    }),
  })
  const body = await response.text()
  if (!response.ok)
    throw new BentoBatchRejectedError(`Bento batch failed (${response.status}): ${body.slice(0, 500)}`, true)

  let parsed: { results?: number, failed?: number }
  try {
    parsed = JSON.parse(body) as { results?: number, failed?: number }
  }
  catch {
    throw new BentoBatchRejectedError(`Bento batch response was not JSON: ${body.slice(0, 500)}`, false)
  }
  if (parsed.results !== events.length || parsed.failed !== 0)
    throw new BentoBatchRejectedError(`Bento batch was not fully accepted: ${body.slice(0, 500)}`, false)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(`Send ${LEGACY_PLUGIN_UPGRADE_BENTO_EVENT} to org admins of apps on the old channel plugin.

Usage:
  bun run admin:notify-legacy-plugin-upgrade [-- --apply] [--min-legacy-devices=N]

${CHANNEL_SELF_STORE_CUTOFF_CAPTION}
Create the Bento automation before --apply. Each email is sent at most once per 24 hours.`)
    return
  }

  const apply = args.includes('--apply')
  const minLegacyDevices = parsePositiveInteger(getArgValue(args, '--min-legacy-devices'), '--min-legacy-devices', 1)
  const env = await loadEnv(getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE)
  const supabase = createSupabaseServiceClient(env)
  const start = new Date(Date.now() - LOOKBACK_MS).toISOString().slice(0, 19).replace('T', ' ')
  const rows = await runAnalyticsQuery(env, `SELECT plugin_version, app_id, count() AS device_count
FROM (
  SELECT argMax(index1, timestamp) AS app_id, argMax(blob3, timestamp) AS plugin_version, blob1 AS device_id
  FROM device_info
  WHERE timestamp >= toDateTime('${start}')
    AND timestamp < now()
    AND blob3 != ''
  GROUP BY index1, blob1
)
WHERE plugin_version != '' AND app_id != ''
GROUP BY plugin_version, app_id`)

  const legacyApps = summarizeLegacyPluginApps(rows.map(row => ({
    app_id: row.app_id,
    plugin_version: row.plugin_version,
    device_count: Number(row.device_count) || 0,
  })), minLegacyDevices)

  const appOwners = new Map<string, string>()
  for (const appIds of chunk(legacyApps.map(app => app.appId), QUERY_CHUNK)) {
    const { data, error } = await supabase.from('apps').select('app_id, owner_org').in('app_id', appIds)
    if (error)
      throw new Error(error.message)
    for (const app of data ?? [])
      appOwners.set(app.app_id, app.owner_org)
  }

  const orgIds = [...new Set(appOwners.values())]
  const orgs = new Map<string, { customerId: string | null, managementEmail: string | null }>()
  for (const ids of chunk(orgIds, QUERY_CHUNK)) {
    const { data, error } = await supabase.from('orgs').select('id, customer_id, management_email').in('id', ids)
    if (error)
      throw new Error(error.message)
    for (const org of data ?? [])
      orgs.set(org.id, { customerId: org.customer_id, managementEmail: org.management_email })
  }

  const { data: plans, error: plansError } = await supabase.from('plans').select('stripe_id, price_m, price_y')
  if (plansError)
    throw new Error(plansError.message)
  const paidProductIds = new Set((plans ?? []).filter(plan => plan.price_m > 0 || plan.price_y > 0).map(plan => plan.stripe_id))
  const customerIds = [...new Set([...orgs.values()].map(org => org.customerId).filter((id): id is string => Boolean(id)))]
  const paidCustomers = new Set<string>()
  for (const ids of chunk(customerIds, QUERY_CHUNK)) {
    const { data, error } = await supabase.from('stripe_info').select('customer_id, product_id, status').in('customer_id', ids).eq('status', 'succeeded')
    if (error)
      throw new Error(error.message)
    for (const row of data ?? []) {
      if (paidProductIds.has(row.product_id))
        paidCustomers.add(row.customer_id)
    }
  }

  const paidOrgIds = new Set([...orgs.entries()].filter(([, org]) => org.customerId && paidCustomers.has(org.customerId)).map(([orgId]) => orgId))
  const paidApps = legacyApps.flatMap((app) => {
    const ownerOrgId = appOwners.get(app.appId)
    if (!ownerOrgId || !paidOrgIds.has(ownerOrgId))
      return []
    return [{ ...app, ownerOrgId }]
  })

  const { data: roles, error: rolesError } = await supabase.from('roles').select('id, name, scope_type').in('name', ADMIN_ROLE_NAMES).eq('scope_type', 'org')
  if (rolesError)
    throw new Error(rolesError.message)
  const roleIds = (roles ?? []).map(role => role.id)
  if (roleIds.length === 0)
    throw new Error('org admin roles were not found')
  const recipientsByOrg = new Map<string, string[]>()
  const userIdsByOrg = new Map<string, Set<string>>()
  const nowMs = Date.now()

  for (const ids of chunk([...paidOrgIds], QUERY_CHUNK)) {
    const { data, error } = await supabase
      .from('role_bindings')
      .select('org_id, principal_type, principal_id, expires_at, role_id')
      .in('org_id', ids)
      .in('role_id', roleIds)
      .eq('scope_type', 'org')
      .limit(5000)
    if (error)
      throw new Error(error.message)
    if ((data ?? []).length >= 5000)
      throw new Error('role binding lookup was truncated; narrow the org chunk')

    const groupIdsByOrg = new Map<string, string[]>()
    for (const binding of data ?? []) {
      if (!binding.org_id || !binding.principal_id)
        continue
      if (binding.expires_at && new Date(binding.expires_at).getTime() <= nowMs)
        continue
      if (binding.principal_type === 'user') {
        const users = userIdsByOrg.get(binding.org_id) ?? new Set<string>()
        users.add(binding.principal_id)
        userIdsByOrg.set(binding.org_id, users)
      }
      if (binding.principal_type === 'group') {
        const groups = groupIdsByOrg.get(binding.org_id) ?? []
        groups.push(binding.principal_id)
        groupIdsByOrg.set(binding.org_id, groups)
      }
    }

    const groupIds = [...new Set([...groupIdsByOrg.values()].flat())]
    const usersByGroup = new Map<string, string[]>()
    for (const groupChunk of chunk(groupIds, QUERY_CHUNK)) {
      const { data: members, error: membersError } = await supabase.from('group_members').select('group_id, user_id').in('group_id', groupChunk).limit(5000)
      if (membersError)
        throw new Error(membersError.message)
      if ((members ?? []).length >= 5000)
        throw new Error('group member lookup was truncated')
      for (const member of members ?? []) {
        if (!member.user_id)
          continue
        const users = usersByGroup.get(member.group_id) ?? []
        users.push(member.user_id)
        usersByGroup.set(member.group_id, users)
      }
    }
    for (const [orgId, groups] of groupIdsByOrg) {
      const users = userIdsByOrg.get(orgId) ?? new Set<string>()
      for (const groupId of groups) {
        for (const userId of usersByGroup.get(groupId) ?? [])
          users.add(userId)
      }
      userIdsByOrg.set(orgId, users)
    }
  }

  const userIds = [...new Set([...userIdsByOrg.values()].flatMap(ids => [...ids]))]
  const emailByUser = new Map<string, string>()
  for (const ids of chunk(userIds, QUERY_CHUNK)) {
    const { data, error } = await supabase.from('users').select('id, email').in('id', ids)
    if (error)
      throw new Error(error.message)
    for (const user of data ?? []) {
      if (user.email)
        emailByUser.set(user.id, user.email)
    }
  }

  for (const orgId of paidOrgIds) {
    const emails = [...userIdsByOrg.get(orgId) ?? []].flatMap(userId => emailByUser.get(userId) ?? [])
    const managementEmail = orgs.get(orgId)?.managementEmail
    if (managementEmail)
      emails.push(managementEmail)
    recipientsByOrg.set(orgId, emails)
  }

  const candidates = buildLegacyPluginUpgradeEvents(paidApps, recipientsByOrg)
  const { latestByRecipient, lastSendAtByRecipientOrg } = await loadUpgradeNotifications(supabase)
  const now = new Date()
  const lastSentAtByEmail = new Map<string, Date>()
  for (const event of candidates) {
    const sentAt = latestByRecipient.get(await legacyPluginUpgradeRecipientId(event.email))
    if (sentAt)
      lastSentAtByEmail.set(event.email, sentAt)
  }
  const events = selectLegacyPluginUpgradeEventsForSend(candidates, lastSentAtByEmail, now)
  const skippedRecent = new Set(candidates.filter(event => !isLegacyPluginUpgradeDue(lastSentAtByEmail.get(event.email), now)).map(event => event.email)).size
  console.log(JSON.stringify({
    apply,
    cutoff: CHANNEL_SELF_STORE_CUTOFF_CAPTION,
    window_start: start,
    legacy_apps: legacyApps.length,
    paid_apps: paidApps.length,
    orgs: new Set(events.map(event => event.details.org_id)).size,
    candidates: candidates.length,
    events: events.length,
    skipped_recent: skippedRecent,
  }))

  if (!apply) {
    console.log('Dry run. Re-run with --apply after the Bento automation exists. Each email is sent at most once per 24 hours.')
    return
  }

  for (const batch of chunk(events, BENTO_BATCH_SIZE)) {
    const claimed = await claimEvents(supabase, batch, lastSendAtByRecipientOrg, new Date())
    if (claimed.length === 0)
      continue
    try {
      await sendBentoBatch(env, claimed.map(claim => ({
        email: claim.event.email,
        event: claim.event.event,
        details: claim.event.details,
      })))
    }
    catch (error) {
      const retryable = !(error instanceof BentoBatchRejectedError) || error.retryable
      if (retryable)
        await rollbackClaims(supabase, claimed)
      throw error
    }
    console.log(`sent ${claimed.length}`)
  }
}

await main()
