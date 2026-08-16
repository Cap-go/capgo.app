import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { NativeNotificationEvent, NativeNotificationPermission, NativeNotificationPlatform, NativeNotificationProvider, NativeNotificationProviderConfig, NativeNotificationRegistryRow, NativeNotificationTarget } from '../../utils/nativeNotifications.ts'
import type { Permission } from '../../utils/rbac.ts'
import { sql } from 'drizzle-orm'
import { BRES, createHono, parseBody, quickError, simpleError, simpleRateLimit, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import {
  createNotificationEventProof,
  createNotificationIdentityProof,
  deriveNativeNotificationIdentity,
  deriveRecipientKey,
  enqueueNativeNotificationFanout,
  getAllNotificationBuckets,
  getNotificationBucket,
  getNotificationDeliveryEventId,
  normalizeNotificationTag,
  readNotificationBadgeStateCF,
  readNotificationRegistrationsCF,
  readNotificationStatsCF,
  shouldTrackNotificationPermissionChanged,
  tombstoneNotificationRegistrationCF,
  trackNotificationEventCF,
  trackNotificationRegistrationCF,
  verifyNotificationDeliveryEventProof,
  verifyNotificationEventProof,
  verifyNotificationIdentityProof,
} from '../../utils/nativeNotifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { isLimited, isValidAppId } from '../../utils/utils.ts'
import { version } from '../../utils/version.ts'

export const app = createHono('', version)

app.use('*', useCors)

const NOTIFICATION_EVENTS = new Set<NativeNotificationEvent>([
  'queued',
  'sent',
  'provider_accepted',
  'received',
  'opened',
  'failed',
  'permission_changed',
  'background_started',
  'background_finished',
  'badge_set',
  'badge_applied',
])
const CLIENT_NOTIFICATION_DELIVERY_EVENTS = new Set<NativeNotificationEvent>([
  'received',
  'opened',
  'background_started',
  'background_finished',
])
const CLIENT_NOTIFICATION_DEVICE_EVENTS = new Set<NativeNotificationEvent>([
  'badge_applied',
])
const NOTIFICATION_PLATFORMS = new Set<NativeNotificationPlatform>(['ios', 'android'])
const NOTIFICATION_PROVIDERS = new Set<NativeNotificationProvider>(['fcm', 'apns'])
const CAMPAIGN_KINDS = new Set(['alert', 'background', 'badge', 'update_check'])
const CAMPAIGN_STATUSES = new Set(['draft', 'scheduled', 'queued', 'sending', 'sent', 'paused', 'failed', 'cancelled'])
const NOTIFICATION_MANAGE_PERMISSION: Permission = 'app.manage_notifications'

interface RegisterBody {
  appId: string
  externalId: string
  nativeInstallId: string
  pushToken: string
  provider?: NativeNotificationProvider
  platform: NativeNotificationPlatform
  locale?: string
  timezone?: string
  appVersion?: string
  pluginVersion?: string
  tags?: string[]
  attributes?: Record<string, unknown>
  permission?: NativeNotificationPermission
  badge?: number
  badgeRevision?: number
  active?: boolean
  consent?: boolean
  identityProof: string
  previousPermission?: NativeNotificationPermission
  previousRecipientKey?: string
  previousDeviceKey?: string
  previousEventProof?: string
}

interface EventBody {
  appId: string
  event: NativeNotificationEvent
  campaignId?: string
  notificationId?: string
  eventId?: string
  occurredAt?: string
  externalId?: string
  nativeInstallId?: string
  recipientKey?: string
  deviceKey?: string
  provider?: NativeNotificationProvider
  platform?: NativeNotificationPlatform
  error?: string
  badge?: number
  badgeRevision?: number
  eventProof: string
}

interface SyncBody {
  appId: string
  nativeInstallId?: string
  recipientKey: string
  deviceKey: string
  platform?: NativeNotificationPlatform
  badge?: number
  badgeRevision?: number
  eventProof: string
}

interface RecipientProofBody {
  appId: string
  externalId: string
}

interface CampaignBody {
  appId: string
  name: string
  kind?: string
  status?: string
  audience?: Record<string, unknown>
  payload?: Record<string, unknown>
  scheduledAt?: string | null
}

interface ProviderBody {
  appId: string
  provider?: NativeNotificationProvider
  platform?: NativeNotificationPlatform
  status?: string
  config?: Record<string, unknown>
  secretRef?: string | null
}

interface SendBody {
  appId: string
  campaignId?: string
  name?: string
  kind?: string
  payload?: Record<string, unknown>
  target?: {
    externalId?: string
    recipientKey?: string
    deviceKey?: string
    tag?: string
    broadcast?: boolean
  }
  limit?: number
}

interface BadgeBody {
  appId: string
  badge: number
  target: SendBody['target']
  campaignId?: string
}

interface SettingsBody {
  appId: string
  pushUpdateEnabled?: boolean
  pushUpdateInstallMode?: 'next' | 'set'
  pushUpdateChannel?: string | null
}

interface UpdateCheckBody {
  appId: string
  target?: NonNullable<SendBody['target']>
  campaignId?: string
  installMode?: 'next' | 'set'
  channel?: string | null
  limit?: number
}

interface ProviderConfigRow {
  provider: NativeNotificationProvider
  status: string
  config: Record<string, unknown> | null
  secret_ref: string | null
}

interface OwnerOrgRow {
  owner_org?: string
}

interface CampaignRecordRow {
  id: string
}

interface NotificationTargetPlan {
  target: NativeNotificationTarget
  buckets: string[]
  limit?: number
}

function assertString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string')
    throw simpleError('invalid_body', 'Invalid body', { field })
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength)
    throw simpleError('invalid_body', 'Invalid body', { field })
  return trimmed
}

function assertOptionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null)
    return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw simpleError('invalid_body', 'Invalid body', { field })
  return value as Record<string, unknown>
}

function assertOptionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '')
    return null
  const raw = assertString(value, field, 128)
  const date = new Date(raw)
  if (Number.isNaN(date.getTime()))
    throw simpleError('invalid_body', 'Invalid body', { field })
  return date.toISOString()
}

function normalizeCampaignKind(kind: string | undefined) {
  return kind && CAMPAIGN_KINDS.has(kind) ? kind : 'alert'
}

function normalizeSendPayload(kind: string, payload: Record<string, unknown>) {
  if (kind !== 'background')
    return payload
  return {
    ...payload,
    kind: 'background',
    background: true,
    silent: true,
  }
}

function assertPublicPluginApp(c: Context<MiddlewareKeyVariables>, appId: string) {
  if (!isValidAppId(appId))
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })
  if (isLimited(c, appId))
    return simpleRateLimit({ app_id: appId })
  return null
}

async function assertAppPermission(c: Context<MiddlewareKeyVariables>, permission: Permission, appId: string) {
  if (!(await checkPermission(c, permission, { appId })))
    throw quickError(403, 'app_access_denied', 'You can\'t access this app', { app_id: appId, permission })
}

async function getNotificationProviderConfigs(c: Context<MiddlewareKeyVariables>, appId: string): Promise<NativeNotificationProviderConfig[]> {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`
      SELECT provider, status, config, secret_ref
      FROM public.notification_provider_configs
      WHERE app_id = ${appId}
        AND status = 'configured'
      ORDER BY provider ASC
    `)
    return (result.rows as unknown as ProviderConfigRow[]).map(row => ({
      provider: row.provider,
      status: row.status,
      config: row.config ?? {},
      secretRef: row.secret_ref,
    }))
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

async function getAppOwnerOrg(c: Context<MiddlewareKeyVariables>, appId: string): Promise<string> {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`SELECT owner_org::text AS owner_org FROM public.apps WHERE app_id = ${appId} LIMIT 1`)
    const ownerOrg = (result.rows[0] as OwnerOrgRow | undefined)?.owner_org
    if (!ownerOrg)
      throw quickError(404, 'app_not_found', 'App not found', { app_id: appId })
    return String(ownerOrg)
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

function normalizeSecretRefSegment(value: string): string {
  let normalized = ''
  let needsSeparator = false
  for (const char of value.toUpperCase()) {
    const code = char.codePointAt(0) ?? 0
    const isAlpha = code >= 65 && code <= 90
    const isDigit = code >= 48 && code <= 57
    if (isAlpha || isDigit) {
      if (needsSeparator && normalized)
        normalized += '_'
      normalized += char
      needsSeparator = false
      if (normalized.length >= 96)
        break
    }
    else if (normalized) {
      needsSeparator = true
    }
  }
  return normalized || 'APP'
}

function expectedProviderSecretRef(appId: string, provider: NativeNotificationProvider) {
  return `NOTIFICATIONS_${normalizeSecretRefSegment(appId)}_${provider === 'apns' ? 'IOS' : 'ANDROID'}`
}

function providerForPlatform(platform: NativeNotificationPlatform): NativeNotificationProvider {
  return platform === 'ios' ? 'apns' : 'fcm'
}

function platformForProvider(provider: NativeNotificationProvider): NativeNotificationPlatform {
  return provider === 'apns' ? 'ios' : 'android'
}

function resolveNotificationProvider(platform: NativeNotificationPlatform, provider?: NativeNotificationProvider): NativeNotificationProvider {
  const expectedProvider = providerForPlatform(platform)
  if (!provider)
    return expectedProvider
  if (!NOTIFICATION_PROVIDERS.has(provider) || provider !== expectedProvider)
    throw simpleError('invalid_platform', 'Invalid notification platform')
  return provider
}

function resolveNotificationEventProvider(body: EventBody): NativeNotificationProvider | undefined {
  if (body.platform)
    return resolveNotificationProvider(body.platform, body.provider)
  if (!body.provider)
    return undefined
  if (!NOTIFICATION_PROVIDERS.has(body.provider))
    throw simpleError('invalid_platform', 'Invalid notification platform')
  return body.provider
}

function resolveProviderConfigProvider(body: ProviderBody): NativeNotificationProvider {
  if (body.platform) {
    if (!NOTIFICATION_PLATFORMS.has(body.platform))
      throw simpleError('invalid_platform', 'Invalid notification platform')
    return resolveNotificationProvider(body.platform, body.provider)
  }
  if (body.provider && NOTIFICATION_PROVIDERS.has(body.provider))
    return body.provider
  throw simpleError('invalid_platform', 'Invalid notification platform')
}

function resolveProviderSecretRef(appId: string, provider: NativeNotificationProvider, status: string, value: string | null | undefined) {
  const expected = expectedProviderSecretRef(appId, provider)
  const requested = typeof value === 'string' ? value.trim() : ''
  if (requested && requested !== expected) {
    throw simpleError('invalid_notification_secret_ref', 'Invalid notification platform secret reference', {
      appId,
      expectedSecretRef: expected,
    })
  }
  return status === 'configured' ? expected : requested || null
}

function optionalConfigString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}

function assertProviderConfigReady(provider: NativeNotificationProvider, status: string, config: Record<string, unknown>, secretRef: string | null) {
  if (status !== 'configured')
    return

  if (!secretRef)
    throw simpleError('missing_notification_secret_ref', 'Missing notification platform secret reference')

  if (provider === 'fcm' && !optionalConfigString(config, 'projectId'))
    throw simpleError('missing_notification_provider_project_id', 'Missing Android push project id')

  if (provider === 'apns') {
    const missing = ['teamId', 'keyId', 'bundleId'].filter(key => !optionalConfigString(config, key))
    if (missing.length)
      throw simpleError('missing_notification_provider_ios_config', 'Missing iOS push config', { missing })
  }
}

function publicDevice(row: NativeNotificationRegistryRow) {
  return {
    deviceKey: row.device_key,
    recipientKey: row.recipient_key,
    platform: row.platform,
    locale: row.locale,
    timezone: row.timezone,
    appVersion: row.app_version,
    pluginVersion: row.plugin_version,
    tags: row.tags,
    attributes: row.attributes,
    badge: row.badge,
    badgeRevision: row.badge_revision ?? 0,
    permission: row.permission,
    updatedAt: row.updated_at,
  }
}

function publicProviderConfig(row: Record<string, unknown>) {
  const provider = row.provider as NativeNotificationProvider
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    owner_org: row.owner_org,
    app_id: row.app_id,
    platform: platformForProvider(provider),
    status: row.status,
    config: row.config,
    secret_ref: row.secret_ref,
  }
}

function publicNotificationSettings(row: Record<string, unknown> | undefined, appId: string) {
  return {
    appId,
    pushUpdateEnabled: Boolean(row?.push_update_enabled ?? false),
    pushUpdateInstallMode: row?.push_update_install_mode === 'set' ? 'set' : 'next',
    pushUpdateChannel: typeof row?.push_update_channel === 'string' ? row.push_update_channel : null,
  }
}

function normalizeTargetLimit(value: unknown): number | undefined {
  if (value === undefined || value === null)
    return undefined
  const limit = Number(value)
  return Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : undefined
}

async function resolveTargetPlan(c: Context<MiddlewareKeyVariables>, body: SendBody | BadgeBody | UpdateCheckBody): Promise<NotificationTargetPlan> {
  const target = body.target ?? {}
  const limit = 'limit' in body ? normalizeTargetLimit(body.limit) : undefined
  if (target.externalId) {
    const recipientKey = await deriveRecipientKey(c, body.appId, target.externalId)
    return { target: { recipientKey }, buckets: [getNotificationBucket(recipientKey)], limit }
  }
  if (target.recipientKey)
    return { target: { recipientKey: target.recipientKey }, buckets: [getNotificationBucket(target.recipientKey)], limit }
  if (target.deviceKey)
    return { target: { deviceKey: target.deviceKey }, buckets: getAllNotificationBuckets(), limit }
  if (target.tag) {
    const tag = normalizeNotificationTag(target.tag)
    if (!tag)
      throw simpleError('invalid_notification_tag', 'Invalid notification tag')
    return { target: { tag }, buckets: getAllNotificationBuckets(), limit }
  }
  if (target.broadcast)
    return { target: { broadcast: true }, buckets: getAllNotificationBuckets(), limit }
  throw simpleError('missing_notification_target', 'Missing notification target')
}

async function getNotificationSettings(c: Context<MiddlewareKeyVariables>, appId: string) {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`
      SELECT app_id, push_update_enabled, push_update_install_mode, push_update_channel
      FROM public.notification_app_settings
      WHERE app_id = ${appId}
      LIMIT 1
    `)
    return publicNotificationSettings(result.rows[0] as Record<string, unknown> | undefined, appId)
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

async function upsertNotificationSettings(c: Context<MiddlewareKeyVariables>, body: SettingsBody) {
  const appId = assertString(body.appId, 'appId', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  const ownerOrg = await getAppOwnerOrg(c, appId)
  const pushUpdateEnabled = body.pushUpdateEnabled === true
  const pushUpdateInstallMode = body.pushUpdateInstallMode === 'set' ? 'set' : 'next'
  const pushUpdateChannel = body.pushUpdateChannel ? assertString(body.pushUpdateChannel, 'pushUpdateChannel', 128) : null
  const auth = c.get('auth')
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`
      INSERT INTO public.notification_app_settings (owner_org, app_id, push_update_enabled, push_update_install_mode, push_update_channel, created_by)
      VALUES (${ownerOrg}::uuid, ${appId}, ${pushUpdateEnabled}, ${pushUpdateInstallMode}, ${pushUpdateChannel}, ${auth?.userId ?? null}::uuid)
      ON CONFLICT (app_id)
      DO UPDATE SET updated_at = now(), push_update_enabled = EXCLUDED.push_update_enabled, push_update_install_mode = EXCLUDED.push_update_install_mode, push_update_channel = EXCLUDED.push_update_channel
      RETURNING app_id, push_update_enabled, push_update_install_mode, push_update_channel
    `)
    return publicNotificationSettings(result.rows[0] as Record<string, unknown>, appId)
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

async function createCampaignRecord(c: Context<MiddlewareKeyVariables>, body: CampaignBody) {
  const appId = assertString(body.appId, 'appId', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  const ownerOrg = await getAppOwnerOrg(c, appId)
  const name = assertString(body.name, 'name', 180)
  const kind = normalizeCampaignKind(body.kind)
  const status = body.status && CAMPAIGN_STATUSES.has(body.status) ? body.status : 'draft'
  const audience = assertOptionalRecord(body.audience, 'audience')
  const payload = assertOptionalRecord(body.payload, 'payload')
  const scheduledAt = assertOptionalDate(body.scheduledAt, 'scheduledAt')
  const auth = c.get('auth')

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`
      INSERT INTO public.notification_campaigns (owner_org, app_id, name, kind, status, audience, payload, scheduled_at, queued_at, created_by)
      VALUES (${ownerOrg}::uuid, ${appId}, ${name}, ${kind}, ${status}, ${JSON.stringify(audience)}::jsonb, ${JSON.stringify(payload)}::jsonb, ${scheduledAt}::timestamptz, CASE WHEN ${status} = 'queued' THEN now() ELSE NULL END, ${auth?.userId ?? null}::uuid)
      RETURNING id, created_at, updated_at, owner_org::text, app_id, name, kind, status, audience, payload, scheduled_at, queued_at, completed_at, counters
    `)
    return result.rows[0]
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

app.post('/register', async (c) => {
  const body = await parseBody<RegisterBody>(c)
  const appId = assertString(body.appId, 'appId', 128)
  const limitedResponse = assertPublicPluginApp(c, appId)
  if (limitedResponse)
    return limitedResponse
  const externalId = assertString(body.externalId, 'externalId', 512)
  const nativeInstallId = assertString(body.nativeInstallId, 'nativeInstallId', 512)
  const pushToken = assertString(body.pushToken, 'pushToken', 4096)
  const identityProof = assertString(body.identityProof, 'identityProof', 256)
  if (!(await verifyNotificationIdentityProof(c, appId, externalId, identityProof)))
    throw quickError(401, 'invalid_notification_identity_proof', 'Invalid notification identity proof', { appId })
  if (!NOTIFICATION_PLATFORMS.has(body.platform))
    throw simpleError('invalid_platform', 'Invalid notification platform')
  const provider = resolveNotificationProvider(body.platform, body.provider)
  const previousRecipientKey = typeof body.previousRecipientKey === 'string' ? body.previousRecipientKey.trim() : ''
  const previousDeviceKey = typeof body.previousDeviceKey === 'string' ? body.previousDeviceKey.trim() : ''
  const previousEventProof = typeof body.previousEventProof === 'string' ? body.previousEventProof.trim() : ''
  if (previousRecipientKey && previousDeviceKey && previousEventProof && !(await verifyNotificationEventProof(c, appId, previousRecipientKey, previousDeviceKey, previousEventProof)))
    throw quickError(401, 'invalid_previous_notification_event_proof', 'Invalid previous notification event proof', { appId })

  const nextIdentity = await deriveNativeNotificationIdentity(c, appId, externalId, nativeInstallId)
  if (previousRecipientKey && previousDeviceKey && previousEventProof && (previousRecipientKey !== nextIdentity.recipientKey || previousDeviceKey !== nextIdentity.deviceKey)) {
    tombstoneNotificationRegistrationCF(c, {
      appId,
      recipientKey: previousRecipientKey,
      deviceKey: previousDeviceKey,
      provider,
      platform: body.platform,
      badge: body.badge,
      permission: body.permission,
    })
  }

  const identity = await trackNotificationRegistrationCF(c, {
    ...body,
    appId,
    externalId,
    nativeInstallId,
    pushToken,
    provider,
  })

  if (shouldTrackNotificationPermissionChanged(body.previousPermission, body.permission)) {
    await trackNotificationEventCF(c, {
      appId,
      event: 'permission_changed',
      recipientKey: identity.recipientKey,
      deviceKey: identity.deviceKey,
      provider,
      platform: body.platform,
      badge: body.badge,
      badgeRevision: body.badgeRevision,
    })
  }

  const eventProof = await createNotificationEventProof(c, appId, identity.recipientKey, identity.deviceKey)

  return c.json({ ...BRES, recipientKey: identity.recipientKey, deviceKey: identity.deviceKey, bucket: identity.bucket, eventProof, badgeRevision: Math.max(0, Math.trunc(body.badgeRevision ?? 0)) })
})

app.post('/events', async (c) => {
  const body = await parseBody<EventBody>(c)
  const appId = assertString(body.appId, 'appId', 128)
  const limitedResponse = assertPublicPluginApp(c, appId)
  if (limitedResponse)
    return limitedResponse
  if (!NOTIFICATION_EVENTS.has(body.event))
    throw simpleError('invalid_notification_event', 'Invalid notification event')
  if (!CLIENT_NOTIFICATION_DELIVERY_EVENTS.has(body.event) && !CLIENT_NOTIFICATION_DEVICE_EVENTS.has(body.event))
    throw simpleError('invalid_notification_client_event', 'Notification event is not accepted from clients')
  if (body.platform && !NOTIFICATION_PLATFORMS.has(body.platform))
    throw simpleError('invalid_platform', 'Invalid notification platform')
  const provider = resolveNotificationEventProvider(body)
  const recipientKey = assertString(body.recipientKey, 'recipientKey', 128)
  const deviceKey = assertString(body.deviceKey, 'deviceKey', 128)
  const eventProof = assertString(body.eventProof, 'eventProof', 256)
  const campaignId = typeof body.campaignId === 'string' ? body.campaignId.trim() : ''
  const notificationId = typeof body.notificationId === 'string' ? body.notificationId.trim() : ''
  const eventId = CLIENT_NOTIFICATION_DELIVERY_EVENTS.has(body.event) && campaignId && notificationId
    ? getNotificationDeliveryEventId({ appId, event: body.event, campaignId, notificationId, deviceKey })
    : typeof body.eventId === 'string' ? body.eventId.trim().slice(0, 256) : ''
  const occurredAt = typeof body.occurredAt === 'string' ? body.occurredAt.trim().slice(0, 64) : ''
  const validProof = CLIENT_NOTIFICATION_DELIVERY_EVENTS.has(body.event)
    ? campaignId && notificationId && await verifyNotificationDeliveryEventProof(c, {
      appId,
      recipientKey,
      deviceKey,
      campaignId,
      notificationId,
      event: body.event,
      proof: eventProof,
    })
    : await verifyNotificationEventProof(c, appId, recipientKey, deviceKey, eventProof)
  if (!validProof)
    throw quickError(401, 'invalid_notification_event_proof', 'Invalid notification event proof', { appId })
  await trackNotificationEventCF(c, {
    appId,
    event: body.event,
    campaignId,
    notificationId,
    recipientKey,
    deviceKey,
    provider,
    platform: body.platform,
    badge: body.badge,
    badgeRevision: body.badgeRevision,
    eventId,
    occurredAt,
  })
  return c.json(BRES)
})

app.post('/sync', async (c) => {
  const body = await parseBody<SyncBody>(c)
  const appId = assertString(body.appId, 'appId', 128)
  const limitedResponse = assertPublicPluginApp(c, appId)
  if (limitedResponse)
    return limitedResponse
  const recipientKey = assertString(body.recipientKey, 'recipientKey', 128)
  const deviceKey = assertString(body.deviceKey, 'deviceKey', 128)
  const eventProof = assertString(body.eventProof, 'eventProof', 256)
  if (!(await verifyNotificationEventProof(c, appId, recipientKey, deviceKey, eventProof)))
    throw quickError(401, 'invalid_notification_event_proof', 'Invalid notification event proof', { appId })
  if (body.platform && !NOTIFICATION_PLATFORMS.has(body.platform))
    throw simpleError('invalid_platform', 'Invalid notification platform')

  const badgeState = await readNotificationBadgeStateCF(c, { appId, recipientKey, deviceKey })
  const desiredRevision = Math.max(0, Math.trunc(badgeState?.badge_revision ?? 0))
  const currentRevision = Math.max(0, Math.trunc(body.badgeRevision ?? 0))
  const desiredBadge = Math.max(0, Math.trunc(badgeState?.badge ?? body.badge ?? 0))
  return c.json({
    ...BRES,
    badge: desiredBadge,
    badgeRevision: desiredRevision,
    shouldApplyBadge: desiredRevision > currentRevision,
  })
})

app.post('/recipients/proof', middlewareAuth(), async (c) => {
  const body = await parseBody<RecipientProofBody>(c)
  const appId = assertString(body.appId, 'appId', 128)
  const externalId = assertString(body.externalId, 'externalId', 512)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  return c.json({ identityProof: await createNotificationIdentityProof(c, appId, externalId) })
})

app.post('/recipients/lookup', middlewareAuth(), async (c) => {
  const body = await parseBody<{ appId: string, externalId?: string, recipientKey?: string, limit?: number }>(c)
  const appId = assertString(body.appId, 'appId', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  const recipientKey = body.recipientKey ?? (body.externalId ? await deriveRecipientKey(c, appId, body.externalId) : undefined)
  if (!recipientKey)
    throw simpleError('missing_recipient', 'Missing recipient')
  const devices = await readNotificationRegistrationsCF(c, { appId, recipientKey, limit: body.limit })
  return c.json({ recipientKey, devices: devices.map(publicDevice), count: devices.length })
})

app.get('/settings', middlewareAuth(), async (c) => {
  const appId = assertString(c.req.query('app_id'), 'app_id', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  return c.json(await getNotificationSettings(c, appId))
})

app.put('/settings', middlewareAuth(), async (c) => {
  const body = await parseBody<SettingsBody>(c)
  return c.json(await upsertNotificationSettings(c, body))
})

app.post('/badge', middlewareAuth(), async (c) => {
  const body = await parseBody<BadgeBody>(c)
  const appId = assertString(body.appId, 'appId', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  const badge = Math.max(0, Math.trunc(Number(body.badge)))
  if (!Number.isFinite(badge))
    throw simpleError('invalid_badge', 'Invalid badge')
  const plan = await resolveTargetPlan(c, { ...body, appId, badge })
  const providerConfigs = await getNotificationProviderConfigs(c, appId)
  if (!providerConfigs.length)
    throw simpleError('missing_notification_provider', 'Missing configured notification platform credentials')
  const campaignId = body.campaignId || crypto.randomUUID()
  const badgeRevision = Date.now()
  const queued = await enqueueNativeNotificationFanout(c, {
    kind: 'badge',
    appId,
    campaignId,
    payload: {},
    target: plan.target,
    buckets: plan.buckets,
    limit: plan.limit,
    badge,
    badgeRevision,
    providerConfigs,
  }, plan.buckets)
  return c.json({ ...BRES, campaignId, queued, queuedBuckets: plan.buckets.length, targeted: null, badgeRevision })
})

app.post('/update-check', middlewareAuth(), async (c) => {
  const body = await parseBody<UpdateCheckBody>(c)
  const appId = assertString(body.appId, 'appId', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  const settings = await getNotificationSettings(c, appId)
  if (!settings.pushUpdateEnabled)
    throw simpleError('push_update_disabled', 'Push update is disabled for this app')
  const installMode = body.installMode || settings.pushUpdateInstallMode
  const channel = body.channel ?? settings.pushUpdateChannel
  const target = body.target ?? { broadcast: true }
  const plan = await resolveTargetPlan(c, { appId, target, limit: body.limit })
  const providerConfigs = await getNotificationProviderConfigs(c, appId)
  if (!providerConfigs.length)
    throw simpleError('missing_notification_provider', 'Missing configured notification platform credentials')
  let campaignId = body.campaignId
  if (!campaignId) {
    const campaignRecord = await createCampaignRecord(c, {
      appId,
      name: 'Push update check',
      kind: 'update_check',
      status: 'queued',
      audience: target,
      payload: { installMode, channel, silent: true, background: true },
      scheduledAt: null,
    })
    campaignId = String((campaignRecord as unknown as CampaignRecordRow).id)
  }
  const payload = {
    silent: true,
    background: true,
    collapseId: 'capgo-update-check',
    installMode,
    channel,
    data: {
      capgoAction: 'update_check',
      capgoUpdateInstallMode: installMode,
      ...(channel ? { capgoUpdateChannel: channel } : {}),
    },
  }
  const queued = await enqueueNativeNotificationFanout(c, {
    kind: 'update_check',
    appId,
    campaignId,
    payload,
    target: plan.target,
    buckets: plan.buckets,
    limit: plan.limit,
    providerConfigs,
  }, plan.buckets)
  return c.json({ ...BRES, campaignId, queued, queuedBuckets: plan.buckets.length, targeted: null })
})

app.post('/send', middlewareAuth(), async (c) => {
  const body = await parseBody<SendBody>(c)
  const appId = assertString(body.appId, 'appId', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  const kind = normalizeCampaignKind(body.kind)
  const payload = normalizeSendPayload(kind, assertOptionalRecord(body.payload, 'payload'))
  const plan = await resolveTargetPlan(c, { ...body, appId })
  const providerConfigs = await getNotificationProviderConfigs(c, appId)
  if (!providerConfigs.length)
    throw simpleError('missing_notification_provider', 'Missing configured notification platform credentials')
  let campaignId = body.campaignId
  if (!campaignId) {
    const campaignRecord = await createCampaignRecord(c, {
      appId,
      name: body.name ? assertString(body.name, 'name', 180) : 'API notification',
      kind,
      status: 'queued',
      audience: body.target ?? {},
      payload,
      scheduledAt: null,
    })
    campaignId = String((campaignRecord as unknown as CampaignRecordRow).id)
  }
  const queued = await enqueueNativeNotificationFanout(c, {
    kind: 'send',
    appId,
    campaignId,
    payload,
    target: plan.target,
    buckets: plan.buckets,
    limit: plan.limit,
    providerConfigs,
  }, plan.buckets)
  return c.json({ ...BRES, campaignId, queued, queuedBuckets: plan.buckets.length, targeted: null })
})

app.get('/campaigns', middlewareAuth(), async (c) => {
  const appId = assertString(c.req.query('app_id'), 'app_id', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`
      SELECT id, created_at, updated_at, owner_org::text, app_id, name, kind, status, audience, payload, scheduled_at, queued_at, completed_at, counters
      FROM public.notification_campaigns
      WHERE app_id = ${appId}
      ORDER BY created_at DESC
      LIMIT 100
    `)
    return c.json({ data: result.rows })
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
})

app.post('/campaigns', middlewareAuth(), async (c) => {
  const body = await parseBody<CampaignBody>(c)
  return c.json(await createCampaignRecord(c, body))
})

app.get('/stats', middlewareAuth(), async (c) => {
  const appId = assertString(c.req.query('app_id'), 'app_id', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  const days = Number(c.req.query('days') ?? 30)
  const campaignId = c.req.query('campaign_id') || undefined
  const data = await readNotificationStatsCF(c, { appId, campaignId, days })
  return c.json({ data })
})

app.get('/providers', middlewareAuth(), async (c) => {
  const appId = assertString(c.req.query('app_id'), 'app_id', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`
      SELECT id, created_at, updated_at, owner_org::text, app_id, provider, status, config, secret_ref
      FROM public.notification_provider_configs
      WHERE app_id = ${appId}
      ORDER BY provider ASC
    `)
    return c.json({ data: result.rows.map(row => publicProviderConfig(row as Record<string, unknown>)) })
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
})

app.put('/providers', middlewareAuth(), async (c) => {
  const body = await parseBody<ProviderBody>(c)
  const appId = assertString(body.appId, 'appId', 128)
  await assertAppPermission(c, NOTIFICATION_MANAGE_PERMISSION, appId)
  const provider = resolveProviderConfigProvider(body)
  const status = body.status && ['draft', 'configured', 'disabled', 'error'].includes(body.status) ? body.status : 'draft'
  const ownerOrg = await getAppOwnerOrg(c, appId)
  const config = assertOptionalRecord(body.config, 'config')
  const secretRef = resolveProviderSecretRef(appId, provider, status, body.secretRef)
  assertProviderConfigReady(provider, status, config, secretRef)
  const auth = c.get('auth')
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`
      INSERT INTO public.notification_provider_configs (owner_org, app_id, provider, status, config, secret_ref, created_by)
      VALUES (${ownerOrg}::uuid, ${appId}, ${provider}, ${status}, ${JSON.stringify(config)}::jsonb, ${secretRef}, ${auth?.userId ?? null}::uuid)
      ON CONFLICT (app_id, provider)
      DO UPDATE SET updated_at = now(), status = EXCLUDED.status, config = EXCLUDED.config, secret_ref = EXCLUDED.secret_ref
      RETURNING id, created_at, updated_at, owner_org::text, app_id, provider, status, config, secret_ref
    `)
    return c.json(publicProviderConfig(result.rows[0] as Record<string, unknown>))
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
})
