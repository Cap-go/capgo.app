import type { Context } from 'hono'
import { parseCronExpression } from 'cron-schedule'
import { and, eq, inArray } from 'drizzle-orm'
import { isBentoConfigured, trackBentoEvent } from './bento.ts'
import { CacheHelper } from './cache.ts'
import { cloudlog } from './logging.ts'
import { claimNotifOrgOnce, hasNotifOrgClaim, sendNotifOrg, sendNotifOrgOnce } from './notifications.ts'
import { closeClient, getDrizzleClient, getPgClient, logPgError } from './pg.ts'
import * as schema from './postgres_schema.ts'
import { logSkippedSupabaseWrite, shouldQueuePluginNotifications, shouldSkipSupabaseNotificationWrites } from './supabase_write_guard.ts'
import { backgroundTask } from './utils.ts'

// Cache path for org member notifications (separate from single-email notifications)
const NOTIF_ORG_MEMBERS_CACHE_PATH = '/.notif-org-members-sendable'

interface NotifCachePayload {
  sendable: boolean
}

function buildOrgMembersNotifCacheRequest(c: Context, orgId: string, eventName: string, uniqId: string) {
  const helper = new CacheHelper(c)
  if (!helper.available)
    return null
  return {
    helper,
    request: helper.buildRequest(NOTIF_ORG_MEMBERS_CACHE_PATH, { org_id: orgId, event: eventName, uniq_id: uniqId }),
  }
}

async function getOrgMembersNotifCacheStatus(c: Context, orgId: string, eventName: string, uniqId: string): Promise<boolean | null> {
  const cacheEntry = buildOrgMembersNotifCacheRequest(c, orgId, eventName, uniqId)
  if (!cacheEntry)
    return null
  const payload = await cacheEntry.helper.matchJson<NotifCachePayload>(cacheEntry.request)
  if (!payload)
    return null
  return payload.sendable
}

function setOrgMembersNotifCacheStatus(c: Context, orgId: string, eventName: string, uniqId: string, sendable: boolean, ttlSeconds: number) {
  return backgroundTask(c, async () => {
    const cacheEntry = buildOrgMembersNotifCacheRequest(c, orgId, eventName, uniqId)
    if (!cacheEntry)
      return
    await cacheEntry.helper.putJson(cacheEntry.request, { sendable }, ttlSeconds)
  })
}

/**
 * Calculate seconds until the next cron window opens based on last send time.
 */
function getSecondsUntilNextCronWindow(lastSendAt: string, cron: string): number {
  const interval = parseCronExpression(cron)
  const lastSendDate = new Date(lastSendAt)
  const now = new Date()
  const nextDate = interval.getNextDate(lastSendDate)
  const diffMs = nextDate.getTime() - now.getTime()
  // Return at least 1 second, and cap at reasonable max (1 week)
  return Math.max(1, Math.min(Math.ceil(diffMs / 1000), 604800))
}

/**
 * Email preference keys that map to the JSONB email_preferences column in both users and orgs tables.
 * These control which types of emails a user/org wants to receive.
 */
export type EmailPreferenceKey
  = | 'usage_limit'
    | 'credit_usage'
    | 'onboarding'
    | 'builder_onboarding'
    | 'weekly_stats'
    | 'monthly_stats'
    | 'billing_period_stats'
    | 'deploy_stats_24h'
    | 'bundle_created'
    | 'bundle_deployed'
    | 'device_error'
    | 'channel_self_rejected'
    | 'daily_fail_ratio'
    | 'cli_realtime_feed'
    | 'bundle_incompatible'

export interface EmailPreferences {
  usage_limit?: boolean
  credit_usage?: boolean
  onboarding?: boolean
  builder_onboarding?: boolean
  weekly_stats?: boolean
  monthly_stats?: boolean
  billing_period_stats?: boolean
  deploy_stats_24h?: boolean
  bundle_created?: boolean
  bundle_deployed?: boolean
  device_error?: boolean
  channel_self_rejected?: boolean
  daily_fail_ratio?: boolean
  cli_realtime_feed?: boolean
  bundle_incompatible?: boolean
}

/**
 * Which org members receive a notification.
 * - 'admins': org_admin + org_super_admin (org management + usage-credit data; the default).
 * - 'billing': org_super_admin + org_billing_admin (billing/payment actions; the org.update_billing holders).
 */
export type NotificationAudience = 'admins' | 'billing'

const AUDIENCE_ROLE_NAMES: Record<NotificationAudience, string[]> = {
  admins: ['org_admin', 'org_super_admin'],
  billing: ['org_super_admin', 'org_billing_admin'],
}

interface OrgWithPreferences {
  management_email: string
  email_preferences?: EmailPreferences | null
}

interface EligibleEmailTargets {
  allEmails: string[]
  primaryEmail: string | null
  additionalEmails: string[]
}

interface PreparedEligibleEmailTargets extends EligibleEmailTargets {
  adminEmails: string[]
  managementEmail: string | null
  org: OrgWithPreferences
}

interface EligibleOrgMemberEmailsResult {
  emails: string[]
  resolutionFailed: boolean
}


type OrgRoleBindingRow = {
  principal_id: string | null
  expires_at: Date | null
}

function isActiveOrgRoleBinding(binding: OrgRoleBindingRow, now: Date): boolean {
  const expiresAt = binding.expires_at ? new Date(binding.expires_at) : null
  return !expiresAt || expiresAt > now
}

async function fetchOrgScopeRoleBindings(
  c: Context,
  orgId: string,
  drizzle: ReturnType<typeof getDrizzleClient>,
  adminRoleNames: string[],
  principalType: 'user' | 'group',
  errorMessage: string,
): Promise<{ bindings: OrgRoleBindingRow[], failed: boolean }> {
  try {
    const bindings = await drizzle
      .select({
        principal_id: schema.role_bindings.principal_id,
        expires_at: schema.role_bindings.expires_at,
      })
      .from(schema.role_bindings)
      .innerJoin(schema.roles, eq(schema.role_bindings.role_id, schema.roles.id))
      .where(
        and(
          eq(schema.role_bindings.org_id, orgId),
          eq(schema.role_bindings.principal_type, principalType),
          eq(schema.role_bindings.scope_type, 'org'),
          inArray(schema.roles.name, adminRoleNames),
        ),
      )

    return { bindings, failed: false }
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: errorMessage, orgId, error })
    return { bindings: [], failed: true }
  }
}

async function collectOrgAudienceUserIds(
  c: Context,
  orgId: string,
  drizzle: ReturnType<typeof getDrizzleClient>,
  adminRoleNames: string[],
  logPrefix: string,
): Promise<{ userIds: Set<string>, resolutionFailed: boolean }> {
  const now = new Date()
  let resolutionFailed = false
  const userIds = new Set<string>()

  const userBindingsResult = await fetchOrgScopeRoleBindings(
    c,
    orgId,
    drizzle,
    adminRoleNames,
    'user',
    `${logPrefix} rbac user error`,
  )
  resolutionFailed ||= userBindingsResult.failed
  for (const binding of userBindingsResult.bindings) {
    if (!isActiveOrgRoleBinding(binding, now))
      continue
    if (binding.principal_id)
      userIds.add(binding.principal_id)
  }

  const groupBindingsResult = await fetchOrgScopeRoleBindings(
    c,
    orgId,
    drizzle,
    adminRoleNames,
    'group',
    `${logPrefix} rbac group error`,
  )
  resolutionFailed ||= groupBindingsResult.failed

  const groupIds = groupBindingsResult.bindings
    .filter(binding => isActiveOrgRoleBinding(binding, now))
    .map(binding => binding.principal_id)
    .filter((groupId): groupId is string => Boolean(groupId))

  if (groupIds.length > 0) {
    try {
      const groupMembers = await drizzle
        .select({ user_id: schema.group_members.user_id })
        .from(schema.group_members)
        .where(inArray(schema.group_members.group_id, groupIds))

      for (const member of groupMembers) {
        if (member.user_id)
          userIds.add(member.user_id)
      }
    }
    catch (error) {
      resolutionFailed = true
      cloudlog({ requestId: c.get('requestId'), message: `${logPrefix} group members error`, orgId, error })
    }
  }

  return { userIds, resolutionFailed }
}

function normalizeUniqueEmails(users: { email: string | null }[]): string[] {
  const emails: string[] = []
  const emailSet = new Set<string>()

  for (const user of users) {
    const email = user.email?.trim().toLowerCase()
    if (!email || emailSet.has(email))
      continue
    emailSet.add(email)
    emails.push(email)
  }

  return emails
}

interface PreparedEligibleEmailTargetsResult {
  recipients: PreparedEligibleEmailTargets | null
  resolutionFailed: boolean
}

/**
 * Get org info including management_email and email_preferences using drizzle client
 */
async function getOrgInfoWithClient(
  c: Context,
  orgId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<OrgWithPreferences | null> {
  try {
    const org = await drizzleClient
      .select({
        management_email: schema.orgs.management_email,
        email_preferences: schema.orgs.email_preferences,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1)
      .then(data => data[0])

    if (!org) {
      cloudlog({ requestId: c.get('requestId'), message: 'getOrgInfo not found', orgId })
      return null
    }

    return {
      management_email: org.management_email,
      email_preferences: (org.email_preferences as EmailPreferences | null) ?? {},
    }
  }
  catch (e: unknown) {
    logPgError(c, 'getOrgInfo', e)
    return null
  }
}

/**
 * Check if org has the specified email preference enabled
 */
function isOrgPreferenceEnabled(org: OrgWithPreferences, preferenceKey: EmailPreferenceKey): boolean {
  const prefs = org.email_preferences ?? {}
  const prefValue = prefs[preferenceKey]
  return prefValue === undefined ? true : prefValue
}

/**
 * Get all RBAC admin/super_admin members of an organization who have the specified email preference enabled.
 * Returns array of emails that should receive the notification.
 */
async function getEligibleOrgMemberEmails(
  c: Context,
  orgId: string,
  preferenceKey: EmailPreferenceKey,
  drizzle: ReturnType<typeof getDrizzleClient>,
  audience: NotificationAudience = 'admins',
): Promise<EligibleOrgMemberEmailsResult> {
  const adminRoleNames = AUDIENCE_ROLE_NAMES[audience]

  try {
    const { userIds, resolutionFailed: audienceResolutionFailed } = await collectOrgAudienceUserIds(
      c,
      orgId,
      drizzle,
      adminRoleNames,
      'getEligibleOrgMemberEmails',
    )
    let resolutionFailed = audienceResolutionFailed

    const userIdList = Array.from(userIds)
    if (userIdList.length === 0)
      return { emails: [], resolutionFailed }

    let users: { id: string, email: string, email_preferences: unknown }[] = []
    try {
      users = await drizzle
        .select({
          id: schema.users.id,
          email: schema.users.email,
          email_preferences: schema.users.email_preferences,
        })
        .from(schema.users)
        .where(inArray(schema.users.id, userIdList))
    }
    catch (error) {
      resolutionFailed = true
      cloudlog({ requestId: c.get('requestId'), message: 'getEligibleOrgMemberEmails users error', orgId, error })
      return { emails: [], resolutionFailed }
    }

    const eligibleEmails: string[] = []
    const emailSet = new Set<string>()

    for (const user of users) {
      const email = user.email as string | null | undefined
      if (!email || emailSet.has(email))
        continue

      const prefs = (user.email_preferences as EmailPreferences | null) ?? {}
      const prefValue = prefs[preferenceKey]
      const isEnabled = prefValue === undefined ? true : prefValue

      if (isEnabled) {
        emailSet.add(email)
        eligibleEmails.push(email)
      }
    }

    return { emails: eligibleEmails, resolutionFailed }
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'getEligibleOrgMemberEmails users error', orgId, error })
    return { emails: [], resolutionFailed: true }
  }
}

/**
 * Get all eligible emails for org notifications, including management_email if:
 * 1. It's different from any admin user's email
 * 2. The org's email preference for this notification type is enabled
 */
async function getAllEligibleEmails(
  c: Context,
  orgId: string,
  preferenceKey: EmailPreferenceKey,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  audience: NotificationAudience = 'admins',
): Promise<{ adminEmails: string[], managementEmail: string | null, org: OrgWithPreferences | null, resolutionFailed: boolean }> {
  // Get org info
  const org = await getOrgInfoWithClient(c, orgId, drizzleClient)
  if (!org) {
    return { adminEmails: [], managementEmail: null, org: null, resolutionFailed: false }
  }

  // Get eligible admin emails
  const { emails: adminEmails, resolutionFailed } = await getEligibleOrgMemberEmails(c, orgId, preferenceKey, drizzleClient, audience)

  // Check if management_email should receive the notification:
  // 1. Must be different from all admin emails
  // 2. Org must have the preference enabled
  let managementEmail: string | null = null

  if (org.management_email) {
    const isDifferentFromAdmins = !adminEmails.includes(org.management_email)
    const isOrgPrefEnabled = isOrgPreferenceEnabled(org, preferenceKey)

    if (isDifferentFromAdmins && isOrgPrefEnabled) {
      managementEmail = org.management_email
    }
  }

  return { adminEmails, managementEmail, org, resolutionFailed }
}

function getEligibleEmailTargets(adminEmails: string[], managementEmail: string | null): EligibleEmailTargets {
  const allEmails = Array.from(new Set([
    ...adminEmails,
    ...(managementEmail ? [managementEmail] : []),
  ]))
  const primaryEmail = managementEmail ?? adminEmails[0] ?? null
  const additionalEmails = primaryEmail
    ? allEmails.filter(email => email !== primaryEmail)
    : allEmails

  return {
    allEmails,
    primaryEmail,
    additionalEmails,
  }
}

async function getPreparedEligibleEmailTargets(
  c: Context,
  orgId: string,
  preferenceKey: EmailPreferenceKey,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  audience: NotificationAudience = 'admins',
): Promise<PreparedEligibleEmailTargetsResult> {
  const { adminEmails, managementEmail, org, resolutionFailed } = await getAllEligibleEmails(c, orgId, preferenceKey, drizzleClient, audience)
  if (!org)
    return { recipients: null, resolutionFailed }

  return {
    recipients: {
      adminEmails,
      managementEmail,
      org,
      ...getEligibleEmailTargets(adminEmails, managementEmail),
    },
    resolutionFailed,
  }
}

async function buildOneTimeRecipientNotifUniqId(uniqId: string, email: string): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase()
  const data = new TextEncoder().encode(normalizedEmail)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')

  return `${uniqId}:${hash}`
}

/**
 * Send an email notification to all eligible org members (admin/super_admin with preference enabled).
 * Also sends to management_email if it's different from admin emails and org preference is enabled.
 *
 * @param c - Hono context
 * @param eventName - The Bento event name (e.g., 'user:weekly_stats')
 * @param preferenceKey - The key in email_preferences JSONB column
 * @param eventData - Metadata to include in the email event
 * @param orgId - The organization ID
 * @returns Number of emails successfully sent
 */
export async function sendEmailToOrgMembers(
  c: Context,
  eventName: string,
  preferenceKey: EmailPreferenceKey,
  eventData: Record<string, any>,
  orgId: string,
  drizzleClient?: ReturnType<typeof getDrizzleClient>,
): Promise<number> {
  // If Bento isn't configured, sending is impossible; skip DB work entirely.
  // This also keeps CI/test runs fast/stable.
  if (!isBentoConfigured(c))
    return 0

  const client = drizzleClient ?? getDrizzleClient(getPgClient(c, true))
  const { recipients } = await getPreparedEligibleEmailTargets(c, orgId, preferenceKey, client)
  if (!recipients) {
    cloudlog({ requestId: c.get('requestId'), message: 'sendEmailToOrgMembers: org not found', orgId })
    return 0
  }

  const { adminEmails, managementEmail, allEmails } = recipients

  if (allEmails.length === 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'sendEmailToOrgMembers: no eligible recipients',
      eventName,
      preferenceKey,
      orgId,
    })
    return 0
  }

  // Send emails in background - don't await
  for (const email of allEmails) {
    backgroundTask(c, trackBentoEvent(c, email, eventData, eventName))
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'sendEmailToOrgMembers: queued',
    eventName,
    preferenceKey,
    orgId,
    totalRecipients: allEmails.length,
    adminRecipients: adminEmails.length,
    managementEmailIncluded: !!managementEmail,
  })

  return allEmails.length
}

/**
 * Send an email notification to org members with rate limiting via notifications table.
 * Uses the same cron-based throttling as sendNotifOrg but sends to all eligible members.
 * Also sends to management_email if it's different from admin emails and org preference is enabled.
 *
 * @param c - Hono context
 * @param eventName - The Bento event name
 * @param preferenceKey - The key in email_preferences JSONB column
 * @param eventData - Metadata to include in the email event
 * @param orgId - The organization ID
 * @param uniqId - Unique identifier for this notification instance (for deduplication)
 * @param cron - Cron expression for rate limiting (e.g., '0 0 * * 1' for weekly)
 * @returns true if emails were sent, { sent: false, lastSendAt } if throttled, false if error
 */
export async function sendNotifToOrgMembers(
  c: Context,
  eventName: string,
  preferenceKey: EmailPreferenceKey,
  eventData: Record<string, any>,
  orgId: string,
  uniqId: string,
  cron: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  audience: NotificationAudience = 'admins',
): Promise<boolean | { sent: false, lastSendAt: string }> {
  if (shouldSkipSupabaseNotificationWrites(c)) {
    logSkippedSupabaseWrite(c, 'sendNotifToOrgMembers')
    return false
  }

  // If Bento isn't configured, sending is impossible; skip DB work entirely.
  if (!isBentoConfigured(c))
    return false

  // Get all eligible emails (includes org info)
  const { recipients } = await getPreparedEligibleEmailTargets(c, orgId, preferenceKey, drizzleClient, audience)
  if (!recipients) {
    cloudlog({ requestId: c.get('requestId'), message: 'sendNotifToOrgMembers: org not found', orgId })
    return false
  }

  const { managementEmail, allEmails, primaryEmail, additionalEmails } = recipients
  if (allEmails.length === 0 || !primaryEmail) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'sendNotifToOrgMembers: no eligible recipients',
      eventName,
      preferenceKey,
      orgId,
    })
    return false
  }

  // Use sendNotifOrg to handle the notification table logic (throttling/deduplication)
  // and send to a single eligible recipient first. Other eligible recipients are
  // fanned out afterwards without duplicating the primary address.
  const orgEmailSent = await sendNotifOrg(c, eventName, eventData, orgId, uniqId, cron, primaryEmail, drizzleClient)

  // Handle the "not sendable" case - propagate lastSendAt for caching
  if (typeof orgEmailSent === 'object' && orgEmailSent.sent === false && orgEmailSent.lastSendAt) {
    return { sent: false, lastSendAt: orgEmailSent.lastSendAt }
  }

  if (orgEmailSent !== true) {
    // Notification was throttled, race lost, or error
    return false
  }

  for (const email of additionalEmails) {
    backgroundTask(c, trackBentoEvent(c, email, eventData, eventName))
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'sendNotifToOrgMembers: queued',
    eventName,
    preferenceKey,
    orgId,
    primaryEmail,
    additionalRecipients: additionalEmails.length,
    managementEmailIncluded: !!managementEmail,
  })

  return true
}

export async function sendNotifToOrgMembersOnce(
  c: Context,
  eventName: string,
  preferenceKey: EmailPreferenceKey,
  eventData: Record<string, any>,
  orgId: string,
  uniqId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  audience: NotificationAudience = 'admins',
): Promise<boolean> {
  if (shouldSkipSupabaseNotificationWrites(c)) {
    logSkippedSupabaseWrite(c, 'sendNotifToOrgMembersOnce')
    return false
  }

  if (!isBentoConfigured(c))
    return false

  const pgClient = getPgClient(c)
  const writeClient = getDrizzleClient(pgClient)

  try {
    const alreadySentForOrg = await hasNotifOrgClaim(c, writeClient, eventName, orgId, uniqId)
    if (alreadySentForOrg === null) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'sendNotifToOrgMembersOnce: org claim lookup failed',
        eventName,
        preferenceKey,
        orgId,
        uniqId,
      })
      return false
    }
    if (alreadySentForOrg) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'sendNotifToOrgMembersOnce: org already claimed',
        eventName,
        preferenceKey,
        orgId,
        uniqId,
      })
      // false = not newly sent this call. Callers that mirror to PostHog/etc must
      // not treat idempotent "already claimed" as a fresh delivery.
      return false
    }

    const { recipients, resolutionFailed } = await getPreparedEligibleEmailTargets(c, orgId, preferenceKey, writeClient, audience)
    if (!recipients) {
      cloudlog({ requestId: c.get('requestId'), message: 'sendNotifToOrgMembersOnce: org not found', orgId })
      return false
    }
    if (resolutionFailed) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'sendNotifToOrgMembersOnce: recipient resolution failed',
        eventName,
        preferenceKey,
        orgId,
      })
      return false
    }

    const { managementEmail, allEmails, primaryEmail, additionalEmails } = recipients
    if (allEmails.length === 0 || !primaryEmail) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'sendNotifToOrgMembersOnce: no eligible recipients',
        eventName,
        preferenceKey,
        orgId,
      })
      return false
    }

    const recipientEmails = [primaryEmail, ...additionalEmails]
    const recipientEntries: { email: string, recipientUniqId: string, wasAlreadyClaimedBeforeRun: boolean }[] = []
    for (const email of recipientEmails) {
      const recipientUniqId = await buildOneTimeRecipientNotifUniqId(uniqId, email)
      const wasAlreadyClaimedBeforeRun = await hasNotifOrgClaim(c, writeClient, eventName, orgId, recipientUniqId)
      if (wasAlreadyClaimedBeforeRun === null) {
        cloudlog({
          requestId: c.get('requestId'),
          message: 'sendNotifToOrgMembersOnce: recipient claim lookup failed',
          eventName,
          preferenceKey,
          orgId,
          recipientUniqId,
        })
        return false
      }
      recipientEntries.push({ email, recipientUniqId, wasAlreadyClaimedBeforeRun })
    }

    const sendResults: { cleanupFailed: boolean, email: string, recipientUniqId: string, sent: boolean, wasAlreadyClaimedBeforeRun: boolean }[] = []
    for (const recipient of recipientEntries) {
      if (recipient.wasAlreadyClaimedBeforeRun) {
        sendResults.push({ ...recipient, sent: false, cleanupFailed: false })
        continue
      }

      const sendResult = await sendNotifOrgOnce(c, eventName, eventData, orgId, recipient.recipientUniqId, recipient.email, drizzleClient, writeClient)
      sendResults.push({ ...recipient, ...sendResult })
    }

    const sentEmails = sendResults
      .filter(result => result.sent)
      .map(result => result.email)
    const cleanupFailedEmails = sendResults
      .filter(result => result.cleanupFailed)
      .map(result => result.email)
    const alreadyClaimedBeforeRunEmails = sendResults
      .filter(result => result.wasAlreadyClaimedBeforeRun)
      .map(result => result.email)

    if (cleanupFailedEmails.length > 0) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'sendNotifToOrgMembersOnce: recipient cleanup failed',
        eventName,
        preferenceKey,
        orgId,
        cleanupFailedRecipients: cleanupFailedEmails,
      })
      return false
    }

    const unresolvedResults = sendResults.filter(result => !result.sent && !result.wasAlreadyClaimedBeforeRun)
    if (unresolvedResults.length > 0)
      return false

    const firstOrgSend = await claimNotifOrgOnce(c, eventName, orgId, uniqId, writeClient)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'sendNotifToOrgMembersOnce: delivered',
      eventName,
      preferenceKey,
      orgId,
      primaryEmail,
      additionalRecipients: additionalEmails.length,
      deliveredRecipients: sentEmails.length,
      alreadyClaimedRecipients: alreadyClaimedBeforeRunEmails.length,
      firstOrgSend,
      managementEmailIncluded: !!managementEmail,
    })

    return firstOrgSend
  }
  finally {
    await closeClient(c, pgClient)
  }
}

/**
 * Cached version of sendNotifToOrgMembers that checks cache before querying the database.
 * If a notification was recently checked and found to be "not sendable", the cached
 * result is returned immediately without hitting the database.
 *
 * The cache TTL is calculated based on the cron schedule and last send time,
 * so the cache expires exactly when the notification becomes sendable again.
 */
export async function sendNotifToOrgMembersCached(
  c: Context,
  eventName: string,
  preferenceKey: EmailPreferenceKey,
  eventData: Record<string, any>,
  orgId: string,
  uniqId: string,
  cron: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  audience: NotificationAudience = 'admins',
): Promise<boolean> {
  if (shouldQueuePluginNotifications(c)) {
    const { queuePluginOrgMembersNotification } = await import('./plugin_notification_queue.ts')
    await queuePluginOrgMembersNotification(c, {
      eventName,
      preferenceKey,
      eventData,
      orgId,
      uniqId,
      cron,
      audience,
    })
    return false
  }

  // Check cache first - if we recently checked and found it wasn't sendable, skip DB query
  const cachedSendable = await getOrgMembersNotifCacheStatus(c, orgId, eventName, uniqId)
  if (cachedSendable === false) {
    cloudlog({ requestId: c.get('requestId'), message: 'sendNotifToOrgMembers cache hit - not sendable', event: eventName, orgId, uniqId })
    return false
  }

  // Cache miss, call the actual function
  const result = await sendNotifToOrgMembers(c, eventName, preferenceKey, eventData, orgId, uniqId, cron, drizzleClient, audience)

  // Handle the "not sendable" case with lastSendAt for proper TTL calculation
  if (typeof result === 'object' && result.sent === false && result.lastSendAt) {
    const ttlSeconds = getSecondsUntilNextCronWindow(result.lastSendAt, cron)
    cloudlog({ requestId: c.get('requestId'), message: 'sendNotifToOrgMembers caching not sendable', event: eventName, orgId, ttlSeconds })
    setOrgMembersNotifCacheStatus(c, orgId, eventName, uniqId, false, ttlSeconds)
    return false
  }

  // For other cases (true/false), just return the boolean result
  // No need to cache "sent=true" as next check should query DB anyway
  return result === true
}


/**
 * Resolve org admin/super_admin member emails for Bento profile tagging.
 * Unlike notification delivery, tagging ignores email preference opt-outs.
 */
export async function getOrgAdminMemberEmailsForTags(
  c: Context,
  orgId: string,
  drizzle: ReturnType<typeof getDrizzleClient>,
  audience: NotificationAudience = 'admins',
): Promise<EligibleOrgMemberEmailsResult> {
  const adminRoleNames = AUDIENCE_ROLE_NAMES[audience]

  try {
    const { userIds, resolutionFailed: audienceResolutionFailed } = await collectOrgAudienceUserIds(
      c,
      orgId,
      drizzle,
      adminRoleNames,
      'getOrgAdminMemberEmailsForTags',
    )
    let resolutionFailed = audienceResolutionFailed

    const userIdList = Array.from(userIds)
    if (userIdList.length === 0)
      return { emails: [], resolutionFailed }

    try {
      const users = await drizzle
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, userIdList))

      return { emails: normalizeUniqueEmails(users), resolutionFailed }
    }
    catch (error) {
      resolutionFailed = true
      cloudlog({ requestId: c.get('requestId'), message: 'getOrgAdminMemberEmailsForTags users error', orgId, error })
      return { emails: [], resolutionFailed }
    }
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'getOrgAdminMemberEmailsForTags error', orgId, error })
    return { emails: [], resolutionFailed: true }
  }
}

export const orgEmailNotificationTestUtils = {
  getEligibleEmailTargets,
}
