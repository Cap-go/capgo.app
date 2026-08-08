import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { escapeSqlString, formatDateCF, normalizeAnalyticsLimit, runQueryToCFA } from './cloudflare.ts'
import { simpleError } from './hono.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

const NOTIFICATION_BUCKET_COUNT = 256
const NOTIFICATION_REGISTRY_RETENTION_DAYS = 92
const DEFAULT_NOTIFICATION_REGISTRY_DATASET = 'notification_registry'
const DEFAULT_NOTIFICATION_EVENTS_DATASET = 'notification_events'
const MAX_TAGS = 32
const MAX_TAG_LENGTH = 64
const MAX_ATTRIBUTES_BLOB_LENGTH = 2048
const IDENTITY_PROOF_PREFIX = 'identity-proof:v1'
const EVENT_PROOF_PREFIX = 'event-proof:v1'
const DELIVERY_EVENT_PROOF_PREFIX = 'delivery-event-proof:v1'

const textEncoder = new TextEncoder()

export type NativeNotificationPlatform = 'ios' | 'android'
export type NativeNotificationProvider = 'fcm' | 'apns'
export type NativeNotificationPermission = 'unknown' | 'prompt' | 'granted' | 'denied'
export type NativeNotificationEvent
  = | 'queued'
    | 'sent'
    | 'provider_accepted'
    | 'received'
    | 'opened'
    | 'failed'
    | 'permission_changed'
    | 'background_started'
    | 'background_finished'
    | 'badge_set'
    | 'badge_applied'

export interface NativeNotificationTarget {
  externalId?: string
  recipientKey?: string
  deviceKey?: string
  tag?: string
  broadcast?: boolean
}

export interface NativeNotificationProviderConfig {
  provider: NativeNotificationProvider
  status: string
  config: Record<string, unknown>
  secretRef?: string | null
}

export interface NativeNotificationRegisterInput {
  appId: string
  externalId: string
  nativeInstallId: string
  pushToken: string
  provider: NativeNotificationProvider
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
}

export interface NativeNotificationResolvedIdentity {
  appId: string
  recipientKey: string
  deviceKey: string
  bucket: string
  index: string
}

export interface NativeNotificationRegistryRow {
  device_key: string
  recipient_key: string
  encrypted_token: string
  token_hash: string
  provider: NativeNotificationProvider
  platform: NativeNotificationPlatform
  locale: string
  timezone: string
  app_version: string
  plugin_version: string
  tags: string
  attributes: string
  active: number
  badge: number
  badge_revision?: number
  permission: number
  consent: number
  updated_at: string
}

export interface NativeNotificationEventInput {
  appId: string
  event: NativeNotificationEvent
  campaignId?: string
  notificationId?: string
  externalId?: string
  nativeInstallId?: string
  recipientKey?: string
  deviceKey?: string
  provider?: NativeNotificationProvider
  platform?: NativeNotificationPlatform
  error?: string
  badge?: number
  badgeRevision?: number
  eventId?: string
  occurredAt?: string
}

export interface NativeNotificationQueueMessage {
  kind: 'send' | 'badge' | 'update_check'
  appId: string
  campaignId: string
  payload: Record<string, unknown>
  target?: NativeNotificationTarget
  buckets?: string[]
  registryCursorDeviceKey?: string
  devices?: NativeNotificationRegistryRow[]
  limit?: number
  badge?: number
  badgeRevision?: number
  providerConfigs?: NativeNotificationProviderConfig[]
  attempt?: number
  sendBatchSize?: number
  skipQueuedEvents?: boolean
}

export interface NativeNotificationStatsRow {
  event: string
  count: number
}

export interface NativeNotificationBadgeStateRow {
  badge: number
  badge_revision: number
  event_id: string
  updated_at: string
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCodePoint(byte)
  })
  let encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_')
  while (encoded.endsWith('='))
    encoded = encoded.slice(0, -1)
  return encoded
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.codePointAt(i) ?? 0
  return bytes
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value))
  return toHex(digest)
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value))
  return toHex(signature)
}

async function aesKeyFromSecret(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function getNotificationHashSecret(c: Context): string {
  const secret = getEnv(c, 'NOTIFICATIONS_HMAC_SECRET') || getEnv(c, 'API_SECRET')
  if (!secret)
    throw simpleError('missing_notifications_hmac_secret', 'Missing notification HMAC secret')
  return secret
}

function getNotificationTokenSecret(c: Context): string {
  const secret = getEnv(c, 'NOTIFICATIONS_TOKEN_SECRET') || getEnv(c, 'API_SECRET')
  if (!secret)
    throw simpleError('missing_notifications_token_secret', 'Missing notification token secret')
  return secret
}

function safeDatasetName(name: string, fallback: string): string {
  return /^\w+$/.test(name) ? name : fallback
}

function getRegistryDataset(c: Context): string {
  return safeDatasetName(getEnv(c, 'NOTIFICATION_REGISTRY_DATASET') || DEFAULT_NOTIFICATION_REGISTRY_DATASET, DEFAULT_NOTIFICATION_REGISTRY_DATASET)
}

function getEventsDataset(c: Context): string {
  return safeDatasetName(getEnv(c, 'NOTIFICATION_EVENTS_DATASET') || DEFAULT_NOTIFICATION_EVENTS_DATASET, DEFAULT_NOTIFICATION_EVENTS_DATASET)
}

function permissionToNumber(permission: NativeNotificationPermission | undefined): number {
  switch (permission) {
    case 'granted': return 2
    case 'denied': return 3
    case 'prompt': return 1
    default: return 0
  }
}

export function shouldTrackNotificationPermissionChanged(previous: NativeNotificationPermission | undefined, next: NativeNotificationPermission | undefined): boolean {
  return !previous || previous !== next
}

function trimText(value: string | undefined, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

export function normalizeNotificationTag(tag: string | undefined): string {
  return typeof tag === 'string' ? tag.trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, MAX_TAG_LENGTH) : ''
}

function normalizeTags(tags: string[] | undefined): string {
  if (!Array.isArray(tags))
    return ''
  const normalized = [...new Set(tags
    .filter(tag => typeof tag === 'string')
    .map(tag => normalizeNotificationTag(tag))
    .filter(Boolean))]
    .slice(0, MAX_TAGS)
  return normalized.length ? `|${normalized.join('|')}|` : ''
}

function normalizeAttributes(attributes: Record<string, unknown> | undefined): string {
  if (!attributes || typeof attributes !== 'object')
    return ''
  const json = JSON.stringify(attributes)
  return json.length > MAX_ATTRIBUTES_BLOB_LENGTH ? '' : json
}

export function getNotificationBucket(key: string): string {
  const prefix = key.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 2)
  return prefix.padEnd(2, '0')
}

export function getAllNotificationBuckets(): string[] {
  return Array.from({ length: NOTIFICATION_BUCKET_COUNT }, (_, index) => index.toString(16).padStart(2, '0'))
}

export function getNotificationIndex(appId: string, bucket: string): string {
  return `${appId}:${bucket}`
}

export function getNotificationEventIndex(appId: string, campaignId?: string): string {
  return (campaignId ? `${appId}:${campaignId}` : appId).slice(0, 96)
}

function isCampaignScopedNotificationEvent(event: NativeNotificationEvent) {
  return event !== 'permission_changed' && event !== 'badge_applied'
}

export async function deriveNativeNotificationIdentity(
  c: Context,
  appId: string,
  externalId: string,
  nativeInstallId: string,
): Promise<NativeNotificationResolvedIdentity> {
  const secret = getNotificationHashSecret(c)
  const recipientKey = await hmacHex(secret, `recipient:${appId}:${externalId}`)
  const deviceKey = await hmacHex(secret, `device:${appId}:${nativeInstallId}`)
  const bucket = getNotificationBucket(recipientKey)
  return {
    appId,
    recipientKey,
    deviceKey,
    bucket,
    index: getNotificationIndex(appId, bucket),
  }
}

export async function deriveRecipientKey(c: Context, appId: string, externalId: string): Promise<string> {
  return hmacHex(getNotificationHashSecret(c), `recipient:${appId}:${externalId}`)
}

export async function deriveDeviceKey(c: Context, appId: string, nativeInstallId: string): Promise<string> {
  return hmacHex(getNotificationHashSecret(c), `device:${appId}:${nativeInstallId}`)
}

function secureCompare(left: string, right: string): boolean {
  if (!left || !right)
    return false
  let diff = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++)
    diff |= (left.codePointAt(index % left.length) ?? 0) ^ (right.codePointAt(index % right.length) ?? 0)
  return diff === 0
}

export async function createNotificationIdentityProof(c: Context, appId: string, externalId: string): Promise<string> {
  return hmacHex(getNotificationHashSecret(c), `${IDENTITY_PROOF_PREFIX}:${appId}:${externalId}`)
}

export async function verifyNotificationIdentityProof(c: Context, appId: string, externalId: string, proof: string): Promise<boolean> {
  return secureCompare(proof, await createNotificationIdentityProof(c, appId, externalId))
}

export async function createNotificationEventProof(c: Context, appId: string, recipientKey: string, deviceKey: string): Promise<string> {
  return hmacHex(getNotificationHashSecret(c), `${EVENT_PROOF_PREFIX}:${appId}:${recipientKey}:${deviceKey}`)
}

export async function verifyNotificationEventProof(c: Context, appId: string, recipientKey: string, deviceKey: string, proof: string): Promise<boolean> {
  return secureCompare(proof, await createNotificationEventProof(c, appId, recipientKey, deviceKey))
}

export async function createNotificationDeliveryEventProofFromSecret(secret: string, params: {
  appId: string
  recipientKey: string
  deviceKey: string
  campaignId: string
  notificationId: string
  event: NativeNotificationEvent
}): Promise<string> {
  return hmacHex(secret, `${DELIVERY_EVENT_PROOF_PREFIX}:${params.appId}:${params.recipientKey}:${params.deviceKey}:${params.campaignId}:${params.notificationId}:${params.event}`)
}

export async function createNotificationDeliveryEventProof(c: Context, params: {
  appId: string
  recipientKey: string
  deviceKey: string
  campaignId: string
  notificationId: string
  event: NativeNotificationEvent
}): Promise<string> {
  return createNotificationDeliveryEventProofFromSecret(getNotificationHashSecret(c), params)
}

export async function verifyNotificationDeliveryEventProof(c: Context, params: {
  appId: string
  recipientKey: string
  deviceKey: string
  campaignId: string
  notificationId: string
  event: NativeNotificationEvent
  proof: string
}): Promise<boolean> {
  return secureCompare(params.proof, await createNotificationDeliveryEventProof(c, params))
}

export function getNotificationDeliveryEventId(params: {
  appId: string
  event: NativeNotificationEvent
  campaignId: string
  notificationId: string
  deviceKey: string
}): string {
  return `${params.event}:${params.appId}:${params.campaignId}:${params.notificationId}:${params.deviceKey}`
}

export async function encryptNotificationToken(c: Context, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await aesKeyFromSecret(getNotificationTokenSecret(c))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(token))
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(encrypted))}`
}

export async function decryptNotificationToken(c: Context, encryptedToken: string): Promise<string> {
  const [version, ivValue, cipherValue] = encryptedToken.split(':')
  if (version !== 'v1' || !ivValue || !cipherValue)
    throw simpleError('invalid_notification_token_ciphertext', 'Invalid notification token ciphertext')
  const key = await aesKeyFromSecret(getNotificationTokenSecret(c))
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromBase64Url(ivValue)) }, key, new Uint8Array(fromBase64Url(cipherValue)))
  return new TextDecoder().decode(decrypted)
}

export async function trackNotificationRegistrationCF(c: Context<MiddlewareKeyVariables>, input: NativeNotificationRegisterInput) {
  if (!c.env.NOTIFICATION_REGISTRY) {
    cloudlog({ requestId: c.get('requestId'), message: 'NOTIFICATION_REGISTRY not available, native notification registration rejected' })
    throw simpleError('notification_registry_not_configured', 'Notification registry is not configured')
  }

  const identity = await deriveNativeNotificationIdentity(c, input.appId, input.externalId, input.nativeInstallId)
  const encryptedToken = await encryptNotificationToken(c, input.pushToken)
  const tokenHash = await sha256Hex(input.pushToken)

  c.env.NOTIFICATION_REGISTRY.writeDataPoint({
    blobs: [
      identity.deviceKey,
      identity.recipientKey,
      encryptedToken,
      tokenHash,
      input.provider,
      input.platform,
      trimText(input.locale, 32),
      trimText(input.timezone, 64),
      trimText(input.appVersion, 80),
      trimText(input.pluginVersion, 32),
      normalizeTags(input.tags),
      normalizeAttributes(input.attributes),
    ],
    doubles: [
      input.active === false ? 0 : 1,
      Math.max(0, Math.trunc(input.badge ?? 0)),
      permissionToNumber(input.permission),
      input.consent === false ? 0 : 1,
      Math.max(0, Math.trunc(input.badgeRevision ?? 0)),
    ],
    indexes: [identity.index],
  })

  return identity
}

export function tombstoneNotificationRegistrationCF(c: Context<MiddlewareKeyVariables>, params: {
  appId: string
  recipientKey: string
  deviceKey: string
  provider?: NativeNotificationProvider
  platform?: NativeNotificationPlatform
  badge?: number
  permission?: NativeNotificationPermission
}) {
  if (!c.env.NOTIFICATION_REGISTRY)
    return

  c.env.NOTIFICATION_REGISTRY.writeDataPoint({
    blobs: [
      params.deviceKey,
      params.recipientKey,
      '',
      '',
      params.provider ?? '',
      params.platform ?? '',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
    doubles: [
      0,
      Math.max(0, Math.trunc(params.badge ?? 0)),
      permissionToNumber(params.permission),
      0,
      0,
    ],
    indexes: [getNotificationIndex(params.appId, getNotificationBucket(params.recipientKey))],
  })
}

export function buildNotificationRegistryLookupQuery(params: {
  dataset: string
  appId: string
  buckets?: string[]
  recipientKey?: string
  deviceKey?: string
  deviceKeyAfter?: string
  tag?: string
  limit?: number
  orderByDeviceKey?: boolean
  now?: Date
}) {
  const since = new Date((params.now?.getTime() ?? Date.now()) - NOTIFICATION_REGISTRY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const indexes = resolveNotificationBuckets(params).map(bucket => `'${escapeSqlString(getNotificationIndex(params.appId, bucket))}'`).join(', ')
  const innerConditions = [
    `index1 IN (${indexes})`,
    `timestamp >= toDateTime('${formatDateCF(since)}')`,
  ]
  const outerConditions = ['active = 1', 'consent = 1']

  if (params.deviceKeyAfter)
    innerConditions.push(`blob1 > '${escapeSqlString(params.deviceKeyAfter)}'`)
  if (params.recipientKey)
    outerConditions.push(`recipient_key = '${escapeSqlString(params.recipientKey)}'`)
  if (params.deviceKey)
    outerConditions.push(`device_key = '${escapeSqlString(params.deviceKey)}'`)
  if (params.deviceKeyAfter)
    outerConditions.push(`device_key > '${escapeSqlString(params.deviceKeyAfter)}'`)
  const tag = normalizeNotificationTag(params.tag)
  if (tag)
    outerConditions.push(`position('|${escapeSqlString(tag)}|' IN tags) > 0`)

  const limit = normalizeAnalyticsLimit(params.limit, 1000)
  return `SELECT *
FROM (
  SELECT
    argMax(blob1, timestamp) AS device_key,
    argMax(blob2, timestamp) AS recipient_key,
    argMax(blob3, timestamp) AS encrypted_token,
    argMax(blob4, timestamp) AS token_hash,
    argMax(blob5, timestamp) AS provider,
    argMax(blob6, timestamp) AS platform,
    argMax(blob7, timestamp) AS locale,
    argMax(blob8, timestamp) AS timezone,
    argMax(blob9, timestamp) AS app_version,
    argMax(blob10, timestamp) AS plugin_version,
    argMax(blob11, timestamp) AS tags,
    argMax(blob12, timestamp) AS attributes,
    argMax(double1, timestamp) AS active,
    argMax(double2, timestamp) AS badge,
    argMax(double3, timestamp) AS permission,
    argMax(double4, timestamp) AS consent,
    argMax(double5, timestamp) AS badge_revision,
    max(timestamp) AS updated_at
  FROM ${params.dataset}
  WHERE ${innerConditions.join(' AND ')}
  GROUP BY blob1
)
WHERE ${outerConditions.join(' AND ')}
ORDER BY ${params.orderByDeviceKey ? 'device_key ASC' : 'updated_at DESC'}
LIMIT ${limit}`
}

function resolveNotificationBuckets(params: {
  buckets?: string[]
  recipientKey?: string
  deviceKey?: string
}) {
  if (params.buckets?.length)
    return params.buckets
  if (params.recipientKey)
    return [getNotificationBucket(params.recipientKey)]
  return getAllNotificationBuckets()
}

export async function readNotificationRegistrationsCF(c: Context<MiddlewareKeyVariables>, params: {
  appId: string
  recipientKey?: string
  deviceKey?: string
  deviceKeyAfter?: string
  tag?: string
  buckets?: string[]
  limit?: number
  orderByDeviceKey?: boolean
}) {
  if (!getEnv(c, 'CF_ANALYTICS_TOKEN') || !getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID'))
    return [] as NativeNotificationRegistryRow[]

  const query = buildNotificationRegistryLookupQuery({
    dataset: getRegistryDataset(c),
    appId: params.appId,
    buckets: resolveNotificationBuckets(params),
    recipientKey: params.recipientKey,
    deviceKey: params.deviceKey,
    deviceKeyAfter: params.deviceKeyAfter,
    tag: params.tag,
    limit: params.limit,
    orderByDeviceKey: params.orderByDeviceKey,
  })

  cloudlog({ requestId: c.get('requestId'), message: 'readNotificationRegistrationsCF query', query })
  try {
    return await runQueryToCFA<NativeNotificationRegistryRow>(c, query)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'readNotificationRegistrationsCF error', error: serializeError(error) })
    throw simpleError('notification_registry_query_failed', 'Notification registry lookup failed')
  }
}

export const MAX_ORG_NOTIFICATION_STATS_APPS = 64

export function buildNotificationStatsQuery(params: {
  dataset: string
  appId?: string
  appIds?: string[]
  campaignId?: string
  days?: number
  now?: Date
}) {
  const rawDays = Number(params.days)
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.trunc(rawDays), 1), 92) : 30
  const since = new Date((params.now?.getTime() ?? Date.now()) - days * 24 * 60 * 60 * 1000)
  const appIds = (params.appIds?.length
    ? params.appIds
    : (params.appId ? [params.appId] : [])).filter(Boolean)
  if (!appIds.length)
    throw new Error('buildNotificationStatsQuery requires appId or appIds')

  let indexCondition: string
  if (params.campaignId) {
    if (appIds.length !== 1)
      throw new Error('campaign_id stats require a single appId')
    indexCondition = `index1 = '${escapeSqlString(getNotificationEventIndex(appIds[0]!, params.campaignId))}' AND blob2 = '${escapeSqlString(params.campaignId)}'`
  }
  else {
    indexCondition = appIds.map((appId) => {
      const appIndex = escapeSqlString(getNotificationEventIndex(appId))
      return `(index1 = '${appIndex}' OR startsWith(index1, '${appIndex}:'))`
    }).join(' OR ')
  }

  return `SELECT blob1 AS event, COUNT(DISTINCT if(blob9 = '', concat(toString(timestamp), ':', blob1, ':', blob3, ':', blob4), blob9)) AS count\n`
    + `FROM ${params.dataset}\n`
    + `WHERE timestamp >= toDateTime('${formatDateCF(since)}')\n`
    + `  AND (${indexCondition})\n`
    + `GROUP BY blob1\n`
    + `ORDER BY count DESC`
}


export function buildGlobalNotificationStatsQuery(params: {
  dataset: string
  since: Date
  until?: Date
}) {
  const untilClause = params.until
    ? `\n  AND timestamp < toDateTime('${formatDateCF(params.until)}')`
    : ''
  return `SELECT blob1 AS event, COUNT(DISTINCT if(blob9 = '', concat(toString(timestamp), ':', blob1, ':', blob3, ':', blob4), blob9)) AS count\n`
    + `FROM ${params.dataset}\n`
    + `WHERE timestamp >= toDateTime('${formatDateCF(params.since)}')${untilClause}\n`
    + `GROUP BY blob1\n`
    + `ORDER BY count DESC`
}

export async function readGlobalNotificationStatsCF(c: Context<MiddlewareKeyVariables>, params: {
  since: Date
  until?: Date
  throwOnError?: boolean
}) {
  if (!getEnv(c, 'CF_ANALYTICS_TOKEN') || !getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID')) {
    const error = new Error('Cloudflare Analytics Engine is not configured for notification stats')
    cloudlogErr({ requestId: c.get('requestId'), message: 'readGlobalNotificationStatsCF missing credentials', error: serializeError(error) })
    if (params.throwOnError)
      throw error
    return [] as NativeNotificationStatsRow[]
  }
  const query = buildGlobalNotificationStatsQuery({
    dataset: getEventsDataset(c),
    since: params.since,
    until: params.until,
  })
  try {
    return await runQueryToCFA<NativeNotificationStatsRow>(c, query)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'readGlobalNotificationStatsCF error', error: serializeError(error) })
    if (params.throwOnError)
      throw error
    return [] as NativeNotificationStatsRow[]
  }
}

export async function readNotificationStatsCF(c: Context<MiddlewareKeyVariables>, params: {
  appId?: string
  appIds?: string[]
  campaignId?: string
  days?: number
  throwOnError?: boolean
}) {
  if (!getEnv(c, 'CF_ANALYTICS_TOKEN') || !getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID'))
    return [] as NativeNotificationStatsRow[]
  const query = buildNotificationStatsQuery({
    dataset: getEventsDataset(c),
    appId: params.appId,
    appIds: params.appIds,
    campaignId: params.campaignId,
    days: params.days,
  })
  try {
    return await runQueryToCFA<NativeNotificationStatsRow>(c, query)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'readNotificationStatsCF error', error: serializeError(error) })
    if (params.throwOnError)
      throw error
    return [] as NativeNotificationStatsRow[]
  }
}

export function buildNotificationBadgeStateQuery(params: {
  dataset: string
  appId: string
  recipientKey: string
  deviceKey: string
  days?: number
  now?: Date
}) {
  const days = Math.min(Math.max(Math.trunc(params.days ?? 92), 1), 92)
  const since = new Date((params.now?.getTime() ?? Date.now()) - days * 24 * 60 * 60 * 1000)
  const appIndex = escapeSqlString(getNotificationEventIndex(params.appId))
  return `SELECT
  argMax(double1, timestamp) AS badge,
  argMax(double2, timestamp) AS badge_revision,
  argMax(blob9, timestamp) AS event_id,
  max(timestamp) AS updated_at
FROM ${params.dataset}
WHERE timestamp >= toDateTime('${formatDateCF(since)}')
  AND (index1 = '${appIndex}' OR startsWith(index1, '${appIndex}:'))
  AND blob1 = 'badge_set'
  AND blob4 = '${escapeSqlString(params.deviceKey)}'
  AND blob5 = '${escapeSqlString(params.recipientKey)}'
GROUP BY blob4
ORDER BY updated_at DESC
LIMIT 1`
}

export async function readNotificationBadgeStateCF(c: Context<MiddlewareKeyVariables>, params: {
  appId: string
  recipientKey: string
  deviceKey: string
}) {
  if (!getEnv(c, 'CF_ANALYTICS_TOKEN') || !getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID'))
    return null
  const query = buildNotificationBadgeStateQuery({
    dataset: getEventsDataset(c),
    appId: params.appId,
    recipientKey: params.recipientKey,
    deviceKey: params.deviceKey,
  })
  try {
    const rows = await runQueryToCFA<NativeNotificationBadgeStateRow>(c, query)
    return rows[0] ?? null
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'readNotificationBadgeStateCF error', error: serializeError(error) })
    return null
  }
}

export async function trackNotificationEventCF(c: Context<MiddlewareKeyVariables>, input: NativeNotificationEventInput) {
  if (!c.env.NOTIFICATION_EVENTS)
    return

  const campaignId = isCampaignScopedNotificationEvent(input.event) ? input.campaignId : undefined
  const notificationId = isCampaignScopedNotificationEvent(input.event) ? input.notificationId : undefined
  let recipientKey = input.recipientKey ?? ''
  let deviceKey = input.deviceKey ?? ''
  if (!recipientKey && input.externalId)
    recipientKey = await deriveRecipientKey(c, input.appId, input.externalId)
  if (!deviceKey && input.nativeInstallId)
    deviceKey = await deriveDeviceKey(c, input.appId, input.nativeInstallId)

  const index = getNotificationEventIndex(input.appId, campaignId)
  c.env.NOTIFICATION_EVENTS.writeDataPoint({
    blobs: [
      input.event,
      campaignId ?? '',
      notificationId ?? '',
      deviceKey,
      recipientKey,
      input.provider ?? '',
      input.error ?? '',
      input.platform ?? '',
      input.eventId ?? '',
      input.occurredAt ?? '',
    ],
    doubles: [
      Math.max(0, Math.trunc(input.badge ?? 0)),
      Math.max(0, Math.trunc(input.badgeRevision ?? 0)),
    ],
    indexes: [index],
  })
}

export async function enqueueNativeNotification(c: Context<MiddlewareKeyVariables>, message: NativeNotificationQueueMessage) {
  const queue = c.env.NOTIFICATION_QUEUE as { send?: (body: NativeNotificationQueueMessage) => Promise<void> } | undefined
  if (!queue?.send)
    return false
  await queue.send(message)
  return true
}

export async function enqueueNativeNotificationFanout(c: Context<MiddlewareKeyVariables>, message: NativeNotificationQueueMessage, buckets: string[]) {
  const queue = c.env.NOTIFICATION_QUEUE as { send?: (body: NativeNotificationQueueMessage) => Promise<void> } | undefined
  if (!queue?.send)
    return false
  const send = queue.send.bind(queue)

  if (message.limit) {
    await send({
      ...message,
      buckets,
      devices: undefined,
    })
    return true
  }

  await Promise.all(buckets.map(bucket => send({
    ...message,
    buckets: [bucket],
    devices: undefined,
  })))
  return true
}
