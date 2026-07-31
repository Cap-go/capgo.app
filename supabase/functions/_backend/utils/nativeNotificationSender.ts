import type { MessageBatch } from '@cloudflare/workers-types'
import type {
  NativeNotificationProvider,
  NativeNotificationProviderConfig,
  NativeNotificationQueueMessage,
  NativeNotificationRegistryRow,
} from './nativeNotifications.ts'
import { buildNotificationRegistryLookupQuery, createNotificationDeliveryEventProofFromSecret, getAllNotificationBuckets, getNotificationBucket, getNotificationEventIndex, getNotificationIndex } from './nativeNotifications.ts'

type NotificationEnv = Record<string, unknown>
const MAX_NOTIFICATION_RETRY_ATTEMPTS = 3
const DEFAULT_NOTIFICATION_SEND_BATCH_SIZE = 50
const DEFAULT_NOTIFICATION_RETRY_DELAY_SECONDS = 30
const DEFAULT_NOTIFICATION_REGISTRY_DATASET = 'notification_registry'

type NotificationQueueBinding = {
  send?: (body: NativeNotificationQueueMessage, options?: { delaySeconds?: number }) => Promise<unknown>
}
type DeliveryTrackedEvent = 'received' | 'opened' | 'background_started' | 'background_finished'

interface SendOutcome {
  ok: boolean
  transient: boolean
  invalidToken?: boolean
  notificationId?: string
  error?: string
}

interface SendCredentialCache {
  fcmAccessTokens: Map<string, Promise<string>>
  apnsJwtTokens: Map<string, Promise<string>>
}

interface AnalyticsApiResponse {
  data: Array<Record<string, unknown>>
  meta?: Array<{ name: string, type: string }>
}

interface NativeNotificationProcessResult {
  retryDevices: NativeNotificationRegistryRow[]
  remainingDevices: NativeNotificationRegistryRow[]
  continuationMessage?: NativeNotificationQueueMessage
}

interface ResolvedDevicePage {
  devices: NativeNotificationRegistryRow[]
  remainingDevices: NativeNotificationRegistryRow[]
  continuationMessage?: NativeNotificationQueueMessage
}

const textEncoder = new TextEncoder()

function readEnv(env: NotificationEnv, name: string): string {
  const value = env[name]
  if (typeof value === 'string')
    return value
  if (value && typeof value === 'object' && 'value' in value && typeof (value as { value?: unknown }).value === 'string')
    return (value as { value: string }).value
  return ''
}

function readEnvInt(env: NotificationEnv, name: string, fallback: number, max: number): number {
  const raw = Number(readEnv(env, name))
  if (!Number.isFinite(raw) || raw <= 0)
    return fallback
  return Math.min(Math.max(1, Math.trunc(raw)), max)
}

function resolveSendBatchSize(env: NotificationEnv, message: NativeNotificationQueueMessage): number {
  return Math.min(
    Math.max(1, Math.trunc(message.sendBatchSize ?? readEnvInt(env, 'NOTIFICATION_SEND_BATCH_SIZE', DEFAULT_NOTIFICATION_SEND_BATCH_SIZE, 500))),
    500,
  )
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

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.codePointAt(i) ?? 0
  return bytes.buffer
}

function jsonBase64Url(value: Record<string, unknown>): string {
  return toBase64Url(textEncoder.encode(JSON.stringify(value)))
}

async function aesKeyFromSecret(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt'])
}

async function decryptToken(env: NotificationEnv, encryptedToken: string): Promise<string> {
  const secret = readEnv(env, 'NOTIFICATIONS_TOKEN_SECRET') || readEnv(env, 'API_SECRET')
  if (!secret)
    throw new Error('Missing notification token secret')
  const [version, ivValue, cipherValue] = encryptedToken.split(':')
  if (version !== 'v1' || !ivValue || !cipherValue)
    throw new Error('Invalid notification token ciphertext')
  const key = await aesKeyFromSecret(secret)
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromBase64Url(ivValue)) }, key, new Uint8Array(fromBase64Url(cipherValue)))
    return new TextDecoder().decode(decrypted)
  }
  catch {
    throw new Error('Invalid notification token ciphertext')
  }
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function getBoolean(value: unknown): boolean {
  return value === true || value === 'true'
}

function parseSecretValue(env: NotificationEnv, secretRef: string | null | undefined): unknown {
  if (!secretRef)
    return null
  const raw = readEnv(env, secretRef)
  if (!raw)
    return null
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

function createSendCredentialCache(): SendCredentialCache {
  return {
    fcmAccessTokens: new Map(),
    apnsJwtTokens: new Map(),
  }
}

function getProviderConfig(message: NativeNotificationQueueMessage, provider: NativeNotificationProvider): NativeNotificationProviderConfig | null {
  return message.providerConfigs?.find(config => config.provider === provider && config.status === 'configured') ?? null
}

function safeDatasetName(name: string, fallback: string): string {
  return /^\w+$/.test(name) ? name : fallback
}

function getRegistryDataset(env: NotificationEnv): string {
  return safeDatasetName(readEnv(env, 'NOTIFICATION_REGISTRY_DATASET') || DEFAULT_NOTIFICATION_REGISTRY_DATASET, DEFAULT_NOTIFICATION_REGISTRY_DATASET)
}

function convertAnalyticsRows<T>(apiResponse: AnalyticsApiResponse): T[] {
  const meta = apiResponse.meta ?? []
  return apiResponse.data.map((row) => {
    const convertedRow: Record<string, unknown> = {}
    for (const column of meta) {
      const value = row[column.name]
      if (column.type === 'UInt64' && typeof value === 'string')
        convertedRow[column.name] = Number(value)
      else
        convertedRow[column.name] = value
    }
    return { ...row, ...convertedRow } as T
  })
}

async function runAnalyticsQuery<T>(env: NotificationEnv, query: string): Promise<T[]> {
  const token = readEnv(env, 'CF_ANALYTICS_TOKEN')
  const accountId = readEnv(env, 'CF_ACCOUNT_ANALYTICS_ID')
  if (!token || !accountId)
    return []

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain; charset=utf-8',
      'Accept-Encoding': 'gzip, zlib, deflate, zstd, br',
      'User-Agent': 'Capgo/1.0',
    },
    body: query,
  })
  if (!response.ok)
    throw new Error('Unable to read notification registry')
  return convertAnalyticsRows<T>(await response.json() as AnalyticsApiResponse)
}

function chunkDeviceRows(devices: NativeNotificationRegistryRow[], size: number) {
  const chunks: NativeNotificationRegistryRow[][] = []
  for (let index = 0; index < devices.length; index += size)
    chunks.push(devices.slice(index, index + size))
  return chunks
}

function normalizeMessageLimit(limit: unknown): number | undefined {
  if (typeof limit !== 'number' || !Number.isFinite(limit))
    return undefined
  const normalized = Math.trunc(limit)
  return normalized > 0 ? normalized : undefined
}

async function resolveMessageDevicesPage(env: NotificationEnv, message: NativeNotificationQueueMessage, batchSize: number): Promise<ResolvedDevicePage> {
  if (Array.isArray(message.devices)) {
    return {
      devices: message.devices.slice(0, batchSize),
      remainingDevices: message.devices.slice(batchSize),
    }
  }

  const target = message.target
  if (!target)
    return { devices: [], remainingDevices: [] }

  const remainingLimit = normalizeMessageLimit(message.limit)
  const queryLimit = remainingLimit
    ? Math.min(batchSize + 1, remainingLimit)
    : batchSize + 1

  const query = buildNotificationRegistryLookupQuery({
    dataset: getRegistryDataset(env),
    appId: message.appId,
    buckets: message.buckets?.length ? message.buckets : getAllNotificationBuckets(),
    recipientKey: target.recipientKey,
    deviceKey: target.deviceKey,
    deviceKeyAfter: message.registryCursorDeviceKey,
    tag: target.tag,
    limit: queryLimit,
    orderByDeviceKey: true,
  })
  const rows = await runAnalyticsQuery<NativeNotificationRegistryRow>(env, query)
  const devices = rows.slice(0, batchSize)
  const nextCursor = devices.at(-1)?.device_key
  const nextLimit = remainingLimit ? remainingLimit - devices.length : undefined
  const hasMore = rows.length > batchSize && Boolean(nextCursor) && (nextLimit === undefined || nextLimit > 0)
  return {
    devices,
    remainingDevices: [],
    continuationMessage: hasMore
      ? {
          ...message,
          devices: undefined,
          registryCursorDeviceKey: nextCursor,
          limit: nextLimit,
        }
      : undefined,
  }
}

function normalizeData(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, dataValue]) => [key, typeof dataValue === 'string' ? dataValue : JSON.stringify(dataValue)]))
}

function getNotificationHashSecret(env: NotificationEnv): string {
  const secret = readEnv(env, 'NOTIFICATIONS_HMAC_SECRET') || readEnv(env, 'API_SECRET')
  if (!secret)
    throw new Error('Missing notification HMAC secret')
  return secret
}

async function withDeliveryMetadata(env: NotificationEnv, message: NativeNotificationQueueMessage, device: NativeNotificationRegistryRow, notificationId: string): Promise<NativeNotificationQueueMessage> {
  const campaignId = message.campaignId
  const deliveryEvents: DeliveryTrackedEvent[] = ['received', 'opened', 'background_started', 'background_finished']
  const eventProofEntries = await Promise.all(deliveryEvents.map(async event => [
    event,
    await createNotificationDeliveryEventProofFromSecret(getNotificationHashSecret(env), {
      appId: message.appId,
      recipientKey: device.recipient_key,
      deviceKey: device.device_key,
      campaignId,
      notificationId,
      event,
    }),
  ] as const))
  const eventProofs = Object.fromEntries(eventProofEntries) as Record<DeliveryTrackedEvent, string>
  return {
    ...message,
    payload: {
      ...message.payload,
      data: {
        ...(message.payload.data && typeof message.payload.data === 'object' && !Array.isArray(message.payload.data) ? message.payload.data : {}),
        capgoCampaignId: campaignId,
        capgoNotificationId: notificationId,
        capgoRecipientKey: device.recipient_key,
        capgoDeviceKey: device.device_key,
        capgoReceivedEventProof: eventProofs.received,
        capgoOpenedEventProof: eventProofs.opened,
        capgoBackgroundStartedEventProof: eventProofs.background_started,
        capgoBackgroundFinishedEventProof: eventProofs.background_finished,
        ...(Number.isFinite(message.badge) ? { capgoBadge: String(Math.max(0, Math.trunc(message.badge ?? 0))) } : {}),
        ...(Number.isFinite(message.badgeRevision) ? { capgoBadgeRevision: String(Math.max(0, Math.trunc(message.badgeRevision ?? 0))) } : {}),
      },
    },
  }
}

function buildCollapseId(message: NativeNotificationQueueMessage): string {
  const collapseId = getString(message.payload.collapseId)
  return (collapseId || message.campaignId).slice(0, 64)
}

async function signRsaJwt(header: Record<string, unknown>, claims: Record<string, unknown>, privateKeyPem: string): Promise<string> {
  const unsigned = `${jsonBase64Url(header)}.${jsonBase64Url(claims)}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, textEncoder.encode(unsigned))
  return `${unsigned}.${toBase64Url(new Uint8Array(signature))}`
}

async function signEcJwt(header: Record<string, unknown>, claims: Record<string, unknown>, privateKeyPem: string): Promise<string> {
  const unsigned = `${jsonBase64Url(header)}.${jsonBase64Url(claims)}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, textEncoder.encode(unsigned))
  return `${unsigned}.${toBase64Url(new Uint8Array(signature))}`
}

async function loadFcmAccessToken(env: NotificationEnv, providerConfig: NativeNotificationProviderConfig): Promise<string> {
  const secretValue = parseSecretValue(env, providerConfig.secretRef)
  const secretObject = secretValue && typeof secretValue === 'object' ? secretValue as Record<string, unknown> : {}
  const directAccessToken = getString(secretObject.access_token)
  if (directAccessToken)
    return directAccessToken
  const privateKey = getString(secretObject.private_key) || getString(secretValue)
  const clientEmail = getString(secretObject.client_email) || getString(providerConfig.config.serviceAccountEmail)
  if (!privateKey || !clientEmail)
    throw new Error('Missing Android push service account secret')

  const now = Math.floor(Date.now() / 1000)
  const assertion = await signRsaJwt({ alg: 'RS256', typ: 'JWT' }, {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }, privateKey)

  const form = new URLSearchParams()
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer')
  form.set('assertion', assertion)
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const json = await response.json() as { access_token?: string, error?: string }
  if (!response.ok || !json.access_token)
    throw new Error('Unable to get Android push access token')
  return json.access_token
}

async function getFcmAccessToken(env: NotificationEnv, providerConfig: NativeNotificationProviderConfig, cache: SendCredentialCache): Promise<string> {
  const cacheKey = `fcm:${providerConfig.secretRef ?? ''}:${getString(providerConfig.config.serviceAccountEmail)}`
  let tokenPromise = cache.fcmAccessTokens.get(cacheKey)
  if (!tokenPromise) {
    tokenPromise = loadFcmAccessToken(env, providerConfig)
    cache.fcmAccessTokens.set(cacheKey, tokenPromise)
  }
  return tokenPromise
}

function buildFcmBody(token: string, message: NativeNotificationQueueMessage) {
  const data = normalizeData(message.payload.data)
  if (message.kind === 'update_check') {
    data.capgoAction = 'update_check'
    data.capgoUpdateInstallMode = getString(message.payload.installMode) || 'next'
    const channel = getString(message.payload.channel)
    if (channel)
      data.capgoUpdateChannel = channel
  }
  const title = getString(message.payload.title)
  const body = getString(message.payload.body)
  const background = getBoolean(message.payload.background) || getBoolean(message.payload.silent) || message.payload.kind === 'background' || message.kind === 'update_check'
  const fcmMessage: Record<string, unknown> = {
    token,
    data: {
      ...data,
      capgoCampaignId: message.campaignId,
    },
  }

  if (title || body) {
    fcmMessage.notification = {
      title,
      body,
    }
  }

  if (message.kind === 'badge') {
    fcmMessage.apns = {
      headers: { 'apns-push-type': 'alert' },
      payload: { aps: { badge: message.badge ?? 0 } },
    }
    fcmMessage.android = {
      notification: { notification_count: message.badge ?? 0 },
    }
  }
  else if (background) {
    fcmMessage.apns = {
      headers: {
        'apns-push-type': 'background',
        'apns-priority': '5',
        'apns-collapse-id': buildCollapseId(message),
      },
      payload: { aps: { 'content-available': 1 } },
    }
    fcmMessage.android = {
      priority: 'high',
      collapse_key: buildCollapseId(message),
    }
  }

  return { message: fcmMessage }
}

interface FcmErrorDetail {
  '@type'?: string
  'errorCode'?: string
  'fieldViolations'?: Array<{ field?: string }>
}

interface FcmSendError {
  name?: string
  error?: {
    status?: string
    message?: string
    details?: FcmErrorDetail[]
  }
}

function isFcmTokenFieldViolation(detail: FcmErrorDetail): boolean {
  return Array.isArray(detail.fieldViolations) && detail.fieldViolations.some((violation) => {
    const field = violation.field ?? ''
    return field === 'message.token' || field.endsWith('.token')
  })
}

function isInvalidFcmToken(json: FcmSendError): boolean {
  const status = json.error?.status ?? ''
  if (status === 'UNREGISTERED')
    return true
  if (status !== 'INVALID_ARGUMENT')
    return false
  return (json.error?.details ?? []).some(detail =>
    detail.errorCode === 'UNREGISTERED' || isFcmTokenFieldViolation(detail),
  )
}

async function sendFcm(env: NotificationEnv, providerConfig: NativeNotificationProviderConfig, token: string, message: NativeNotificationQueueMessage, cache: SendCredentialCache): Promise<SendOutcome> {
  const secretValue = parseSecretValue(env, providerConfig.secretRef)
  const secretObject = secretValue && typeof secretValue === 'object' ? secretValue as Record<string, unknown> : {}
  const projectId = getString(providerConfig.config.projectId) || getString(secretObject.project_id)
  if (!projectId)
    return { ok: false, transient: false, error: 'Missing Android push project id' }

  const accessToken = await getFcmAccessToken(env, providerConfig, cache)
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(buildFcmBody(token, message)),
  })
  const json = await response.json().catch(() => ({})) as FcmSendError
  if (response.ok)
    return { ok: true, transient: false, notificationId: json.name }

  const status = json.error?.status ?? ''
  const invalidToken = isInvalidFcmToken(json)
  return {
    ok: false,
    transient: response.status === 429 || response.status >= 500,
    invalidToken,
    error: invalidToken ? 'Invalid Android push token' : status || 'Android push rejected notification',
  }
}

async function buildApnsJwt(providerConfig: NativeNotificationProviderConfig, privateKey: string, cache: SendCredentialCache): Promise<string> {
  const teamId = getString(providerConfig.config.teamId)
  const keyId = getString(providerConfig.config.keyId)
  if (!teamId || !keyId)
    throw new Error('Missing iOS push team id or key id')
  const cacheKey = `apns:${providerConfig.secretRef ?? ''}:${teamId}:${keyId}`
  let jwtPromise = cache.apnsJwtTokens.get(cacheKey)
  if (!jwtPromise) {
    jwtPromise = signEcJwt({ alg: 'ES256', kid: keyId }, { iss: teamId, iat: Math.floor(Date.now() / 1000) }, privateKey)
    cache.apnsJwtTokens.set(cacheKey, jwtPromise)
  }
  return jwtPromise
}

function buildApnsPayload(message: NativeNotificationQueueMessage) {
  const data = normalizeData(message.payload.data)
  if (message.kind === 'update_check') {
    data.capgoAction = 'update_check'
    data.capgoUpdateInstallMode = getString(message.payload.installMode) || 'next'
    const channel = getString(message.payload.channel)
    if (channel)
      data.capgoUpdateChannel = channel
  }
  const title = getString(message.payload.title)
  const body = getString(message.payload.body)
  const background = getBoolean(message.payload.background) || getBoolean(message.payload.silent) || message.payload.kind === 'background' || message.kind === 'update_check'
  const aps: Record<string, unknown> = {}

  if (message.kind === 'badge') {
    aps.badge = message.badge ?? 0
  }
  else if (background) {
    aps['content-available'] = 1
  }
  else {
    aps.alert = { title, body }
    aps.sound = getString(message.payload.sound) || 'default'
  }

  return {
    ...data,
    capgoCampaignId: message.campaignId,
    aps,
  }
}

async function sendApns(env: NotificationEnv, providerConfig: NativeNotificationProviderConfig, token: string, message: NativeNotificationQueueMessage, cache: SendCredentialCache): Promise<SendOutcome> {
  const secretValue = parseSecretValue(env, providerConfig.secretRef)
  const secretObject = secretValue && typeof secretValue === 'object' ? secretValue as Record<string, unknown> : {}
  const privateKey = getString(secretObject.private_key) || getString(secretValue)
  const bundleId = getString(providerConfig.config.bundleId)
  if (!privateKey || !bundleId)
    return { ok: false, transient: false, error: 'Missing iOS push key or bundle id' }

  const background = getBoolean(message.payload.background) || getBoolean(message.payload.silent) || message.payload.kind === 'background' || message.kind === 'update_check'
  const host = getBoolean(providerConfig.config.sandbox) || providerConfig.config.environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com'
  const response = await fetch(`${host}/3/device/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${await buildApnsJwt(providerConfig, privateKey, cache)}`,
      'Content-Type': 'application/json',
      'apns-topic': bundleId,
      'apns-push-type': background ? 'background' : 'alert',
      'apns-priority': background ? '5' : '10',
      'apns-collapse-id': buildCollapseId(message),
    },
    body: JSON.stringify(buildApnsPayload(message)),
  })

  if (response.ok)
    return { ok: true, transient: false, notificationId: response.headers.get('apns-id') ?? undefined }

  const json = await response.json().catch(() => ({})) as { reason?: string }
  const reason = json.reason ?? 'iOS push rejected notification'
  return {
    ok: false,
    transient: response.status === 429 || response.status >= 500,
    invalidToken: response.status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken',
    error: reason,
  }
}

function writeNotificationEvent(env: NotificationEnv, input: {
  appId: string
  campaignId: string
  event: string
  notificationId?: string
  device: NativeNotificationRegistryRow
  error?: string
  badge?: number
  badgeRevision?: number
  eventId?: string
}) {
  const binding = env.NOTIFICATION_EVENTS as { writeDataPoint?: (point: { blobs: string[], doubles: number[], indexes: string[] }) => void } | undefined
  if (!binding?.writeDataPoint)
    return
  binding.writeDataPoint({
    blobs: [
      input.event,
      input.campaignId,
      input.notificationId ?? '',
      input.device.device_key,
      input.device.recipient_key,
      input.device.provider,
      input.error ?? '',
      input.device.platform,
      input.eventId ?? `${input.event}:${input.appId}:${input.campaignId}:${input.notificationId ?? ''}:${input.device.device_key}`,
      new Date().toISOString(),
    ],
    doubles: [
      Math.max(0, Math.trunc(input.badge ?? 0)),
      Math.max(0, Math.trunc(input.badgeRevision ?? 0)),
    ],
    indexes: [getNotificationEventIndex(input.appId, input.campaignId)],
  })
}

function writeBadgeDesiredState(env: NotificationEnv, message: NativeNotificationQueueMessage, device: NativeNotificationRegistryRow, notificationId: string) {
  if (message.kind !== 'badge')
    return
  const badgeRevision = Math.max(0, Math.trunc(message.badgeRevision ?? Date.now()))
  writeNotificationEvent(env, {
    appId: message.appId,
    campaignId: message.campaignId,
    event: 'badge_set',
    notificationId,
    device,
    badge: message.badge,
    badgeRevision,
    eventId: `badge-set:${message.appId}:${message.campaignId}:${device.device_key}:${badgeRevision}`,
  })
}

function tombstoneDevice(env: NotificationEnv, appId: string, device: NativeNotificationRegistryRow) {
  const binding = env.NOTIFICATION_REGISTRY as { writeDataPoint?: (point: { blobs: string[], doubles: number[], indexes: string[] }) => void } | undefined
  if (!binding?.writeDataPoint)
    return
  const bucket = getNotificationBucket(device.recipient_key)
  binding.writeDataPoint({
    blobs: [
      device.device_key,
      device.recipient_key,
      '',
      device.token_hash ?? '',
      device.provider,
      device.platform,
      device.locale ?? '',
      device.timezone ?? '',
      device.app_version ?? '',
      device.plugin_version ?? '',
      device.tags ?? '',
      device.attributes ?? '',
    ],
    doubles: [0, Math.max(0, Math.trunc(device.badge ?? 0)), Number(device.permission ?? 0), 0],
    indexes: [getNotificationIndex(appId, bucket)],
  })
}

async function sendToDevice(env: NotificationEnv, message: NativeNotificationQueueMessage, device: NativeNotificationRegistryRow, notificationId: string, cache: SendCredentialCache): Promise<SendOutcome> {
  const providerConfig = getProviderConfig(message, device.provider)
  if (!providerConfig)
    return { ok: false, transient: false, error: `Missing configured provider for ${device.provider}` }
  const deliveryMessage = await withDeliveryMetadata(env, message, device, notificationId)
  const token = await decryptToken(env, device.encrypted_token)
  if (device.provider === 'fcm')
    return sendFcm(env, providerConfig, token, deliveryMessage, cache)
  if (device.provider === 'apns')
    return sendApns(env, providerConfig, token, deliveryMessage, cache)
  return { ok: false, transient: false, error: `Unsupported provider ${device.provider}` }
}

function retryAttempt(message: NativeNotificationQueueMessage): number {
  const attempt = Number(message.attempt ?? 0)
  return Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0
}

function canRetry(message: NativeNotificationQueueMessage): boolean {
  return retryAttempt(message) < MAX_NOTIFICATION_RETRY_ATTEMPTS
}

function retryDelaySeconds(env: NotificationEnv, message: NativeNotificationQueueMessage): number {
  const baseDelay = readEnvInt(env, 'NOTIFICATION_RETRY_DELAY_SECONDS', DEFAULT_NOTIFICATION_RETRY_DELAY_SECONDS, 900)
  return Math.min(baseDelay * 2 ** retryAttempt(message), 900)
}

function shouldRetryThrownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return ![
    'Invalid notification token ciphertext',
    'Missing notification token secret',
    'Missing Android push service account secret',
    'Missing iOS push team id or key id',
  ].some(permanentError => message.includes(permanentError))
}

function writeSuccessfulSend(env: NotificationEnv, message: NativeNotificationQueueMessage, device: NativeNotificationRegistryRow, outcome: SendOutcome) {
  writeNotificationEvent(env, { appId: message.appId, campaignId: message.campaignId, event: 'sent', notificationId: outcome.notificationId, device, badge: message.badge, badgeRevision: message.badgeRevision })
  writeNotificationEvent(env, { appId: message.appId, campaignId: message.campaignId, event: 'provider_accepted', notificationId: outcome.notificationId, device, badge: message.badge, badgeRevision: message.badgeRevision })
}

function writeFailedSend(env: NotificationEnv, message: NativeNotificationQueueMessage, device: NativeNotificationRegistryRow, error?: string, notificationId?: string) {
  writeNotificationEvent(env, { appId: message.appId, campaignId: message.campaignId, event: 'failed', notificationId, device, error, badge: message.badge, badgeRevision: message.badgeRevision })
}

function shouldRetryOutcome(env: NotificationEnv, message: NativeNotificationQueueMessage, device: NativeNotificationRegistryRow, outcome: SendOutcome, shouldRetry: boolean): boolean {
  if (outcome.ok) {
    writeSuccessfulSend(env, message, device, outcome)
    return false
  }

  writeFailedSend(env, message, device, outcome.error, outcome.notificationId)
  if (outcome.invalidToken)
    tombstoneDevice(env, message.appId, device)
  return shouldRetry && outcome.transient
}

async function sendNativeNotificationDevices(message: NativeNotificationQueueMessage, env: NotificationEnv, devices: NativeNotificationRegistryRow[]): Promise<{ retryDevices: NativeNotificationRegistryRow[] }> {
  const retryDevices: NativeNotificationRegistryRow[] = []
  const shouldRetry = canRetry(message)
  const shouldWriteQueuedEvents = !message.skipQueuedEvents
  const credentialCache = createSendCredentialCache()

  for (const device of devices) {
    const notificationId = crypto.randomUUID()
    if (shouldWriteQueuedEvents)
      writeNotificationEvent(env, { appId: message.appId, campaignId: message.campaignId, event: 'queued', notificationId, device, badge: message.badge, badgeRevision: message.badgeRevision })
    writeBadgeDesiredState(env, message, device, notificationId)
    try {
      const outcome = await sendToDevice(env, message, device, notificationId, credentialCache)
      outcome.notificationId = notificationId
      if (shouldRetryOutcome(env, message, device, outcome, shouldRetry))
        retryDevices.push(device)
    }
    catch (error) {
      writeFailedSend(env, message, device, error instanceof Error ? error.message : 'notification send failed', notificationId)
      if (shouldRetry && shouldRetryThrownError(error))
        retryDevices.push(device)
    }
  }

  return { retryDevices }
}

export async function processNativeNotificationQueueMessage(message: NativeNotificationQueueMessage, env: NotificationEnv): Promise<NativeNotificationProcessResult> {
  const batchSize = resolveSendBatchSize(env, message)
  const { devices, remainingDevices, continuationMessage } = await resolveMessageDevicesPage(env, message, batchSize)
  const { retryDevices } = await sendNativeNotificationDevices(message, env, devices)
  return { retryDevices, remainingDevices, continuationMessage }
}

async function enqueueContinuationWork(queue: NotificationQueueBinding, env: NotificationEnv, message: NativeNotificationQueueMessage, remainingDevices: NativeNotificationRegistryRow[], continuationMessage?: NativeNotificationQueueMessage) {
  const send = queue.send?.bind(queue)
  if (!send)
    throw new Error('Notification continuation queue is not configured')
  if (continuationMessage) {
    await send(continuationMessage)
    return
  }
  await Promise.all(chunkDeviceRows(remainingDevices, resolveSendBatchSize(env, message)).map(devices =>
    send({ ...message, devices }),
  ))
}

export async function processNativeNotificationQueueBatch(batch: MessageBatch<NativeNotificationQueueMessage>, env: NotificationEnv) {
  await Promise.all(batch.messages.map(async (queueMessage) => {
    try {
      const batchSize = resolveSendBatchSize(env, queueMessage.body)
      const { devices, remainingDevices, continuationMessage } = await resolveMessageDevicesPage(env, queueMessage.body, batchSize)
      const queue = env.NOTIFICATION_QUEUE as NotificationQueueBinding | undefined
      const { retryDevices } = await sendNativeNotificationDevices(queueMessage.body, env, devices)

      if (continuationMessage || remainingDevices.length) {
        // Queue continuation after this page is attempted so a crash cannot advance the cursor before sending it.
        await enqueueContinuationWork(queue ?? {}, env, queueMessage.body, remainingDevices, continuationMessage)
      }

      if (retryDevices.length) {
        if (!queue?.send)
          throw new Error('Notification retry queue is not configured')
        await queue.send(
          { ...queueMessage.body, attempt: retryAttempt(queueMessage.body) + 1, devices: retryDevices, skipQueuedEvents: true },
          { delaySeconds: retryDelaySeconds(env, queueMessage.body) },
        )
      }
      queueMessage.ack()
    }
    catch {
      queueMessage.retry({ delaySeconds: retryDelaySeconds(env, queueMessage.body) })
    }
  }))
}
