import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import type {
  CapgoBackgroundNotificationEvent,
  CapgoBackgroundNotificationResult,
  CapgoNotificationEvent,
  CapgoNotificationInstallMode,
  CapgoNotificationOpenedEvent,
  CapgoNotificationPermission,
  CapgoNotificationPlatform,
  CapgoNotificationRegisterOptions,
  CapgoNotificationRegistration,
  CapgoNotificationSyncResult,
  CapgoNotificationToken,
  CapgoNotificationsConfig,
  CapgoNotificationsNativePlugin,
  CapgoNotificationsPlugin,
  CapgoPushNotificationSchema,
  CapgoUpdateCheckResult,
  CapgoUpdaterIntegrationOptions,
} from './definitions'
import { PLUGIN_VERSION } from './version'

export * from './definitions'

const NativeCapgoNotifications = registerPlugin<CapgoNotificationsNativePlugin>('CapgoNotifications')
const DEFAULT_SERVER_URL = 'https://api.capgo.app'
const MAX_EVENT_QUEUE_SIZE = 512
const MAX_EVENT_FLUSH_ATTEMPTS = 12
const EVENT_QUEUE_FLUSH_LIMIT = 50

interface UpdaterTriggerResult {
  status?: string
  version?: string
  bundleId?: string
  id?: string
  queued?: boolean
  error?: string
  message?: string
}

interface UpdaterPlugin {
  triggerUpdateCheck?: (options?: { channel?: string, installMode?: CapgoNotificationInstallMode }) => Promise<UpdaterTriggerResult>
  getLatest: (options?: { channel?: string }) => Promise<{ version: string, url?: string, checksum?: string, sessionKey?: string, manifest?: unknown[], error?: string, message?: string }>
  download: (options: { url: string, version: string, checksum?: string, sessionKey?: string, manifest?: unknown[] }) => Promise<{ id: string, version: string }>
  next: (options: { id: string }) => Promise<unknown>
  set: (options: { id: string }) => Promise<unknown>
}

interface StoredNotificationRegistration extends CapgoNotificationRegistration {
  appId: string
  externalId: string
  identityProof?: string
}

interface StoredBadgeState {
  appId: string
  badge: number
  badgeRevision: number
}

type QueuedNotificationEventName = 'received' | 'opened' | 'background_started' | 'background_finished' | 'badge_applied'
type DeliveryTrackedEventName = Exclude<QueuedNotificationEventName, 'badge_applied'>

interface QueuedNotificationEvent extends CapgoNotificationEvent {
  event: QueuedNotificationEventName
  eventId: string
  occurredAt: string
  attempts: number
}

interface ListenerState {
  notificationReceived: Set<(notification: CapgoPushNotificationSchema) => void>
  notificationOpened: Set<(event: CapgoNotificationOpenedEvent) => void>
  backgroundNotification: Set<(event: CapgoBackgroundNotificationEvent) => void>
  registrationChanged: Set<(token: CapgoNotificationToken) => void>
}

interface RuntimeState {
  config?: CapgoNotificationsConfig
  externalId?: string
  identityProof?: string
  tags: string[]
  attributes: Record<string, unknown>
  consent: boolean
  badge: number
  badgeRevision: number
  token?: CapgoNotificationToken
  installId?: string
  bridgeListenersReady: boolean
  bridgeListenersPromise?: Promise<void>
  eventFlushPromise?: Promise<void>
  lastRegistration?: StoredNotificationRegistration
  handledUpdateNotifications: Set<string>
  updateNotificationChecks: Map<string, Promise<void>>
  listeners: ListenerState
  updater: Required<Pick<CapgoUpdaterIntegrationOptions, 'enabled'>> & {
    installMode: CapgoNotificationInstallMode
    channel?: string
  }
}

const state: RuntimeState = {
  tags: [],
  attributes: {},
  consent: true,
  badge: 0,
  badgeRevision: 0,
  bridgeListenersReady: false,
  updateNotificationChecks: new Map(),
  handledUpdateNotifications: new Set(),
  listeners: {
    notificationReceived: new Set(),
    notificationOpened: new Set(),
    backgroundNotification: new Set(),
    registrationChanged: new Set(),
  },
  updater: {
    enabled: true,
    installMode: 'next',
  },
}

let fallbackEventCounter = 0

function assertNativePlatform(): CapgoNotificationPlatform {
  const platform = Capacitor.getPlatform()
  if (platform === 'ios' || platform === 'android')
    return platform
  throw new Error('Capgo notifications are only available on iOS and Android')
}

function getServerUrl(options?: { serverUrl?: string }) {
  return options?.serverUrl || state.config?.serverUrl || DEFAULT_SERVER_URL
}

function getAppId(options?: { appId?: string }) {
  const appId = options?.appId || state.config?.appId
  if (!appId)
    throw new Error('Capgo notification appId is required')
  return appId
}

function registrationStorageKey(appId: string) {
  return `capgo.notifications.registration.v1.${appId}`
}

function badgeStorageKey(appId: string) {
  return `capgo.notifications.badge.v1.${appId}`
}

function eventQueueStorageKey(appId: string) {
  return `capgo.notifications.events.v1.${appId}`
}

function getLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  }
  catch {
    return undefined
  }
}

function readStoredRegistration(appId: string): StoredNotificationRegistration | undefined {
  const storage = getLocalStorage()
  if (!storage)
    return undefined
  try {
    const parsed = JSON.parse(storage.getItem(registrationStorageKey(appId)) || 'null') as Partial<StoredNotificationRegistration> | null
    if (parsed?.appId !== appId || !parsed.externalId || !parsed.recipientKey || !parsed.deviceKey || !parsed.eventProof)
      return undefined
    return parsed as StoredNotificationRegistration
  }
  catch {
    return undefined
  }
}

function writeStoredRegistration(registration: StoredNotificationRegistration) {
  const storage = getLocalStorage()
  if (!storage)
    return
  try {
    storage.setItem(registrationStorageKey(registration.appId), JSON.stringify(registration))
  }
  catch {
    // Best effort cache for cold-start notification event tracking.
  }
}

function readStoredBadgeState(appId: string): StoredBadgeState | undefined {
  const storage = getLocalStorage()
  if (!storage)
    return undefined
  try {
    const parsed = JSON.parse(storage.getItem(badgeStorageKey(appId)) || 'null') as Partial<StoredBadgeState> | null
    if (parsed?.appId !== appId || !Number.isFinite(parsed.badge) || !Number.isFinite(parsed.badgeRevision))
      return undefined
    return {
      appId,
      badge: Math.max(0, Math.trunc(parsed.badge ?? 0)),
      badgeRevision: Math.max(0, Math.trunc(parsed.badgeRevision ?? 0)),
    }
  }
  catch {
    return undefined
  }
}

function writeStoredBadgeState(appId: string) {
  const storage = getLocalStorage()
  if (!storage)
    return
  try {
    storage.setItem(badgeStorageKey(appId), JSON.stringify({
      appId,
      badge: state.badge,
      badgeRevision: state.badgeRevision,
    }))
  }
  catch {
    // Local cache only; the next register/sync still reports the native badge.
  }
}

function hydrateStoredRegistration(appId?: string): StoredNotificationRegistration | undefined {
  if (!appId)
    return state.lastRegistration
  if (state.lastRegistration?.appId === appId)
    return state.lastRegistration
  const storedRegistration = readStoredRegistration(appId)
  if (storedRegistration) {
    state.lastRegistration = storedRegistration
    state.externalId = state.externalId || storedRegistration.externalId
    if (storedRegistration.identityProof)
      state.identityProof = state.identityProof || storedRegistration.identityProof
  }
  return storedRegistration
}

function hydrateStoredBadgeState(appId?: string) {
  if (!appId)
    return
  const storedBadge = readStoredBadgeState(appId)
  if (!storedBadge)
    return
  state.badge = storedBadge.badge
  state.badgeRevision = storedBadge.badgeRevision
}

function readQueuedEvents(appId: string): QueuedNotificationEvent[] {
  const storage = getLocalStorage()
  if (!storage)
    return []
  try {
    const parsed = JSON.parse(storage.getItem(eventQueueStorageKey(appId)) || '[]') as Partial<QueuedNotificationEvent>[]
    if (!Array.isArray(parsed))
      return []
    return parsed
      .filter((event): event is QueuedNotificationEvent => Boolean(event?.event && event.eventId && event.occurredAt))
      .slice(-MAX_EVENT_QUEUE_SIZE)
      .map(event => ({
        ...event,
        attempts: Math.max(0, Math.trunc(event.attempts ?? 0)),
      }))
  }
  catch {
    return []
  }
}

function writeQueuedEvents(appId: string, events: QueuedNotificationEvent[]) {
  const storage = getLocalStorage()
  if (!storage)
    return
  try {
    storage.setItem(eventQueueStorageKey(appId), JSON.stringify(events.slice(-MAX_EVENT_QUEUE_SIZE)))
  }
  catch {
    // If storage is full, keep only the newest events.
    try {
      storage.setItem(eventQueueStorageKey(appId), JSON.stringify(events.slice(-Math.floor(MAX_EVENT_QUEUE_SIZE / 2))))
    }
    catch {
      // Event replay is best effort when the host app storage is unavailable.
    }
  }
}

async function getInstallId() {
  if (state.installId)
    return state.installId
  const result = await NativeCapgoNotifications.getNativeInstallId()
  state.installId = result.nativeInstallId
  return result.nativeInstallId
}

async function getPermissionState(): Promise<CapgoNotificationPermission> {
  const permissions = await NativeCapgoNotifications.checkPermissions()
  if (permissions.receive === 'granted')
    return 'granted'
  if (permissions.receive === 'denied')
    return 'denied'
  if (permissions.receive === 'prompt')
    return 'prompt'
  return 'unknown'
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

async function removeListenerHandles(handles: Array<PluginListenerHandle | undefined>) {
  await Promise.allSettled(handles.map(handle => handle?.remove()).filter((promise): promise is Promise<void> => Boolean(promise)))
}

async function requestToken(): Promise<CapgoNotificationToken> {
  const permission = await NativeCapgoNotifications.requestPermissions()
  if (permission.receive !== 'granted')
    throw new Error('Push notification permission was not granted')

  return new Promise<CapgoNotificationToken>((resolve, reject) => {
    let resolved = false
    let registrationHandle: PluginListenerHandle | undefined
    let errorHandle: PluginListenerHandle | undefined

    const cleanup = () => removeListenerHandles([registrationHandle, errorHandle])
    const succeed = async (token: CapgoNotificationToken) => {
      await cleanup()
      resolve(token)
    }
    const rejectWithCleanup = async (error: unknown) => {
      await cleanup()
      reject(toError(error))
    }
    const complete = (token: CapgoNotificationToken) => {
      if (resolved)
        return
      resolved = true
      state.token = token
      void succeed(token)
    }
    const fail = (error: unknown) => {
      if (resolved)
        return
      resolved = true
      void rejectWithCleanup(error)
    }

    void (async () => {
      try {
        registrationHandle = await NativeCapgoNotifications.addListener('registration', complete)
        errorHandle = await NativeCapgoNotifications.addListener('registrationError', (error) => {
          fail(new Error(error.error))
        })
        await NativeCapgoNotifications.registerPush()
      }
      catch (error) {
        fail(error)
      }
    })()
  })
}

function normalizeUpdaterResult(result: UpdaterTriggerResult): CapgoUpdateCheckResult {
  if (result.status === 'disabled' || result.status === 'unavailable' || result.status === 'no_update' || result.status === 'installed' || result.status === 'failed') {
    return {
      status: result.status,
      version: result.version,
      bundleId: result.bundleId || result.id,
      error: result.error || result.message,
    }
  }
  return {
    status: result.queued ? 'installed' : 'failed',
    version: result.version,
    bundleId: result.bundleId || result.id,
    error: result.error || result.message || 'Update check failed',
  }
}

function notificationData(notification?: CapgoPushNotificationSchema): Record<string, unknown> {
  const data = notification?.data
  return data && typeof data === 'object' ? data : {}
}

function getStringData(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value)
      return value
  }
  return ''
}

function eventProofFromNotificationData(data: Record<string, unknown>, event?: DeliveryTrackedEventName) {
  if (event === 'received')
    return getStringData(data, 'capgoReceivedEventProof', 'capgo_received_event_proof') || undefined
  if (event === 'opened')
    return getStringData(data, 'capgoOpenedEventProof', 'capgo_opened_event_proof') || undefined
  if (event === 'background_started')
    return getStringData(data, 'capgoBackgroundStartedEventProof', 'capgo_background_started_event_proof') || undefined
  if (event === 'background_finished')
    return getStringData(data, 'capgoBackgroundFinishedEventProof', 'capgo_background_finished_event_proof') || undefined
  return getStringData(data, 'capgoEventProof', 'capgo_event_proof') || undefined
}

function eventFromNotification(notification?: CapgoPushNotificationSchema, event?: DeliveryTrackedEventName): CapgoNotificationEvent {
  const data = notificationData(notification)
  return {
    campaignId: getStringData(data, 'capgoCampaignId', 'capgo_campaign_id') || undefined,
    notificationId: getStringData(data, 'capgoNotificationId', 'capgo_notification_id') || notification?.id,
    recipientKey: getStringData(data, 'capgoRecipientKey', 'capgo_recipient_key') || undefined,
    deviceKey: getStringData(data, 'capgoDeviceKey', 'capgo_device_key') || undefined,
    eventProof: eventProofFromNotificationData(data, event),
  }
}

function updateNotificationKey(notification?: CapgoPushNotificationSchema) {
  const data = notificationData(notification)
  const campaignId = getStringData(data, 'capgoCampaignId', 'capgo_campaign_id')
  const notificationId = getStringData(data, 'capgoNotificationId', 'capgo_notification_id') || notification?.id || ''
  if (!campaignId && !notificationId)
    return ''
  return `${campaignId}:${notificationId}`
}

function isUpdateCheckNotification(notification?: CapgoPushNotificationSchema) {
  const data = notificationData(notification)
  const action = getStringData(data, 'capgoAction', 'capgo_action', 'action')
  return action === 'update_check' || action === 'capgo_update_check'
}

function notifyListeners<T>(listeners: Set<(event: T) => void>, event: T) {
  for (const listener of listeners) {
    try {
      listener(event)
    }
    catch (error) {
      setTimeout(() => {
        throw error
      }, 0)
    }
  }
}

function createListenerHandle(remove: () => void): PluginListenerHandle {
  return {
    remove: async () => remove(),
  }
}

function updateOptionsFromNotification(notification?: CapgoPushNotificationSchema): CapgoUpdaterIntegrationOptions {
  const data = notificationData(notification)
  const requestedInstallMode = getStringData(data, 'capgoUpdateInstallMode', 'capgo_update_install_mode')
  const channel = getStringData(data, 'capgoUpdateChannel', 'capgo_update_channel')
  let installMode: CapgoUpdaterIntegrationOptions['installMode']
  if (requestedInstallMode === 'set' || requestedInstallMode === 'next')
    installMode = requestedInstallMode

  return {
    enabled: true,
    installMode,
    channel: channel || undefined,
  }
}

class CapgoNotificationRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CapgoNotificationRequestError'
    this.status = status
  }
}

async function postJson(serverUrl: string, route: string, body: Record<string, unknown>) {
  const url = new URL(route, serverUrl)
  const response = await fetch(url.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const error = await response.text().catch(() => '')
    throw new CapgoNotificationRequestError(response.status, error || 'Capgo notification request failed')
  }
  return response.json() as Promise<Record<string, unknown>>
}

async function hydrateNativeBadge(appId?: string) {
  const nativeBadge = await NativeCapgoNotifications.getBadge().catch(() => undefined)
  if (!nativeBadge || !Number.isFinite(nativeBadge.count))
    return
  state.badge = Math.max(0, Math.trunc(nativeBadge.count))
  if (appId)
    writeStoredBadgeState(appId)
}

async function registerToken(options: CapgoNotificationRegisterOptions, token: CapgoNotificationToken): Promise<CapgoNotificationRegistration> {
  const platform = assertNativePlatform()
  const appInfo = await NativeCapgoNotifications.getAppInfo().catch(() => ({ version: options.appVersion || '' }))
  const nativeInstallId = await getInstallId()
  const permission = await getPermissionState()
  const appId = getAppId(options)
  const serverUrl = getServerUrl(options)
  const identityProof = options.identityProof || state.identityProof
  if (!identityProof)
    throw new Error('Capgo notification identityProof is required')
  hydrateStoredBadgeState(appId)
  await hydrateNativeBadge(appId)
  const previousRegistration = hydrateStoredRegistration(appId)
  const previousIdentity = previousRegistration && previousRegistration.externalId !== options.externalId
    ? {
        previousRecipientKey: previousRegistration.recipientKey,
        previousDeviceKey: previousRegistration.deviceKey,
        previousEventProof: previousRegistration.eventProof,
      }
    : {}

  const response = await postJson(serverUrl, '/notifications/register', {
    appId,
    externalId: options.externalId,
    nativeInstallId,
    pushToken: token.value,
    platform,
    locale: navigator.language || '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    appVersion: options.appVersion || appInfo.version || '',
    pluginVersion: PLUGIN_VERSION,
    identityProof,
    tags: options.tags ?? state.tags,
    attributes: options.attributes ?? state.attributes,
    permission,
    badge: state.badge,
    badgeRevision: state.badgeRevision,
    active: true,
    consent: options.consent ?? state.consent,
    previousPermission: previousRegistration?.permission,
    ...previousIdentity,
  })

  const registration: CapgoNotificationRegistration = {
    recipientKey: String(response.recipientKey),
    deviceKey: String(response.deviceKey),
    bucket: String(response.bucket),
    token: token.value,
    platform,
    permission,
    eventProof: String(response.eventProof),
    badgeRevision: typeof response.badgeRevision === 'number' ? response.badgeRevision : state.badgeRevision,
  }
  if (typeof registration.badgeRevision === 'number')
    state.badgeRevision = Math.max(state.badgeRevision, Math.trunc(registration.badgeRevision))
  state.lastRegistration = { ...registration, appId, externalId: options.externalId, identityProof }
  writeStoredRegistration(state.lastRegistration)
  writeStoredBadgeState(appId)
  await flushEventQueue(appId)
  await syncBadgeWithServer(appId).catch(() => undefined)
  return registration
}

function getNumberData(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value))
      return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed))
        return parsed
    }
  }
  return undefined
}

function badgeFromNotification(notification?: CapgoPushNotificationSchema): { badge?: number, badgeRevision?: number } {
  const data = notificationData(notification)
  const badge = getNumberData(data, 'capgoBadge', 'capgo_badge') ?? notification?.badge
  const badgeRevision = getNumberData(data, 'capgoBadgeRevision', 'capgo_badge_revision')
  return {
    badge: Number.isFinite(badge) ? Math.max(0, Math.trunc(badge ?? 0)) : undefined,
    badgeRevision: Number.isFinite(badgeRevision) ? Math.max(0, Math.trunc(badgeRevision ?? 0)) : undefined,
  }
}

function createEventSuffix() {
  if (typeof globalThis.crypto?.randomUUID === 'function')
    return globalThis.crypto.randomUUID()

  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }

  fallbackEventCounter += 1
  return `${Date.now()}:${fallbackEventCounter}`
}

function createEventId(event: QueuedNotificationEventName, input: CapgoNotificationEvent, appId: string, deviceKey: string) {
  if (input.eventId)
    return input.eventId
  if (input.campaignId && input.notificationId)
    return `notification:${event}:${appId}:${input.campaignId}:${input.notificationId}:${deviceKey}`
  if (event === 'badge_applied' && Number.isFinite(input.badgeRevision))
    return `badge:${event}:${appId}:${deviceKey}:${Math.trunc(input.badgeRevision ?? 0)}:${Math.trunc(input.badge ?? 0)}`
  return `manual:${event}:${appId}:${deviceKey}:${Date.now()}:${createEventSuffix()}`
}

function queueEvent(appId: string, event: QueuedNotificationEvent) {
  const events = readQueuedEvents(appId)
  const existingIndex = events.findIndex(queuedEvent => queuedEvent.eventId === event.eventId)
  if (existingIndex >= 0)
    events[existingIndex] = { ...events[existingIndex], ...event, attempts: events[existingIndex].attempts }
  else
    events.push(event)
  writeQueuedEvents(appId, events)
}

async function postQueuedEvent(event: QueuedNotificationEvent) {
  await postJson(getServerUrl(), '/notifications/events', {
    appId: event.appId,
    event: event.event,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    nativeInstallId: event.nativeInstallId || await getInstallId(),
    externalId: event.externalId || state.externalId,
    recipientKey: event.recipientKey,
    deviceKey: event.deviceKey,
    eventProof: event.eventProof,
    platform: event.platform || assertNativePlatform(),
    campaignId: event.campaignId,
    notificationId: event.notificationId,
    badge: event.badge ?? state.badge,
    badgeRevision: event.badgeRevision ?? state.badgeRevision,
    error: event.error,
  })
}

async function flushEventQueue(appId?: string) {
  const resolvedAppId = appId || state.config?.appId || state.lastRegistration?.appId
  if (!resolvedAppId)
    return
  if (state.eventFlushPromise)
    return state.eventFlushPromise

  state.eventFlushPromise = (async () => {
    const queuedEvents = readQueuedEvents(resolvedAppId)
    if (!queuedEvents.length)
      return

    const remainingEvents: QueuedNotificationEvent[] = []
    const eventsToFlush = queuedEvents.slice(0, EVENT_QUEUE_FLUSH_LIMIT)
    const deferredEvents = queuedEvents.slice(EVENT_QUEUE_FLUSH_LIMIT)

    for (const queuedEvent of eventsToFlush) {
      try {
        await postQueuedEvent(queuedEvent)
      }
      catch (error) {
        const nextAttempts = queuedEvent.attempts + 1
        if (error instanceof CapgoNotificationRequestError && error.status >= 400 && error.status < 500)
          continue
        if (nextAttempts < MAX_EVENT_FLUSH_ATTEMPTS)
          remainingEvents.push({ ...queuedEvent, attempts: nextAttempts })
      }
    }

    writeQueuedEvents(resolvedAppId, [...remainingEvents, ...deferredEvents])
  })().finally(() => {
    state.eventFlushPromise = undefined
  })

  return state.eventFlushPromise
}

async function trackEvent(event: QueuedNotificationEventName, input?: CapgoNotificationEvent) {
  const appId = input?.appId || state.config?.appId || state.lastRegistration?.appId
  if (!appId)
    return
  const registration = hydrateStoredRegistration(appId)
  const recipientKey = input?.recipientKey || registration?.recipientKey
  const deviceKey = input?.deviceKey || registration?.deviceKey
  const eventProof = input?.eventProof || (event === 'badge_applied' ? registration?.eventProof : undefined)
  if ((!recipientKey || !deviceKey || !eventProof || !input?.campaignId || !input.notificationId) && event !== 'badge_applied')
    return
  if (!recipientKey || !deviceKey || !eventProof)
    return
  const platform = assertNativePlatform()
  const queuedEvent: QueuedNotificationEvent = {
    appId,
    event,
    eventId: createEventId(event, input ?? {}, appId, deviceKey),
    occurredAt: input?.occurredAt || new Date().toISOString(),
    attempts: 0,
    nativeInstallId: input?.nativeInstallId || await getInstallId(),
    externalId: input?.externalId || state.externalId,
    recipientKey,
    deviceKey,
    eventProof,
    platform: input?.platform || platform,
    campaignId: input?.campaignId,
    notificationId: input?.notificationId,
    badge: input?.badge ?? state.badge,
    badgeRevision: input?.badgeRevision ?? state.badgeRevision,
    error: input?.error,
  }
  queueEvent(appId, queuedEvent)
  await flushEventQueue(appId)
}

async function applyBadge(count: number, badgeRevision = Date.now(), appId = state.config?.appId || state.lastRegistration?.appId) {
  state.badge = Math.max(0, Math.trunc(count))
  state.badgeRevision = Math.max(state.badgeRevision, Math.trunc(badgeRevision || 0))
  await NativeCapgoNotifications.setBadge({ count: state.badge })
  if (appId)
    writeStoredBadgeState(appId)
}

async function applyBadgeFromNotification(notification?: CapgoPushNotificationSchema) {
  const { badge, badgeRevision } = badgeFromNotification(notification)
  if (!Number.isFinite(badge) || !Number.isFinite(badgeRevision))
    return
  if ((badgeRevision ?? 0) < state.badgeRevision)
    return
  await applyBadge(badge ?? 0, badgeRevision)
  const event = eventFromNotification(notification)
  await trackEvent('badge_applied', {
    ...event,
    badge,
    badgeRevision,
    eventProof: state.lastRegistration?.eventProof || event.eventProof,
  }).catch(() => undefined)
}

async function syncBadgeWithServer(appId?: string): Promise<CapgoNotificationSyncResult> {
  const registration = hydrateStoredRegistration(appId || state.config?.appId)
  const resolvedAppId = appId || registration?.appId || state.config?.appId
  if (!resolvedAppId || !registration)
    return { pendingEvents: 0 }

  await hydrateNativeBadge(resolvedAppId)
  await flushEventQueue(resolvedAppId)

  const response = await postJson(getServerUrl(), '/notifications/sync', {
    appId: resolvedAppId,
    nativeInstallId: await getInstallId(),
    recipientKey: registration.recipientKey,
    deviceKey: registration.deviceKey,
    eventProof: registration.eventProof,
    platform: registration.platform,
    badge: state.badge,
    badgeRevision: state.badgeRevision,
  })

  const badge = typeof response.badge === 'number' ? Math.max(0, Math.trunc(response.badge)) : undefined
  const badgeRevision = typeof response.badgeRevision === 'number' ? Math.max(0, Math.trunc(response.badgeRevision)) : undefined
  let appliedBadge = false
  if (Number.isFinite(badge) && Number.isFinite(badgeRevision) && (badgeRevision ?? 0) > state.badgeRevision) {
    await applyBadge(badge ?? 0, badgeRevision ?? 0, resolvedAppId)
    await trackEvent('badge_applied', {
      appId: resolvedAppId,
      recipientKey: registration.recipientKey,
      deviceKey: registration.deviceKey,
      eventProof: registration.eventProof,
      platform: registration.platform,
      badge,
      badgeRevision,
    }).catch(() => undefined)
    appliedBadge = true
  }
  await flushEventQueue(resolvedAppId)
  return {
    badge: badge ?? state.badge,
    badgeRevision: appliedBadge ? badgeRevision : state.badgeRevision,
    appliedBadge,
    pendingEvents: readQueuedEvents(resolvedAppId).length,
  }
}

async function maybeRunUpdateCheck(notification?: CapgoPushNotificationSchema) {
  if (!isUpdateCheckNotification(notification) || !state.updater.enabled)
    return
  const key = updateNotificationKey(notification)
  if (key) {
    const runningCheck = state.updateNotificationChecks.get(key)
    if (runningCheck)
      return runningCheck
    if (state.handledUpdateNotifications.has(key))
      return
    state.handledUpdateNotifications.add(key)
    if (state.handledUpdateNotifications.size > 128) {
      const oldest = state.handledUpdateNotifications.values().next().value
      if (oldest)
        state.handledUpdateNotifications.delete(oldest)
    }
  }

  const updateCheck = (async () => {
    const startedEvent = eventFromNotification(notification, 'background_started')
    await trackEvent('background_started', startedEvent)
    const result = await CapgoNotifications.runUpdateCheck(updateOptionsFromNotification(notification))
    await trackEvent('background_finished', {
      ...eventFromNotification(notification, 'background_finished'),
      error: result.error,
    })
    if (result.status === 'failed')
      throw new Error(result.error || 'Update check failed')
  })()

  if (key) {
    state.updateNotificationChecks.set(key, updateCheck)
    void updateCheck.finally(() => state.updateNotificationChecks.delete(key)).catch(() => undefined)
  }

  return updateCheck
}

async function addBridgeHandle(handles: PluginListenerHandle[], listenerHandle: Promise<PluginListenerHandle>) {
  const handle = await listenerHandle
  handles.push(handle)
}

async function ensureBridgeListeners() {
  if (state.bridgeListenersReady)
    return
  if (state.bridgeListenersPromise)
    return state.bridgeListenersPromise

  state.bridgeListenersPromise = (async () => {
    const handles: PluginListenerHandle[] = []
    try {
      await addBridgeHandle(handles, NativeCapgoNotifications.addListener('registration', (token) => {
        state.token = token
        if (state.externalId && state.identityProof) {
          void registerToken({
            appId: state.config?.appId,
            serverUrl: state.config?.serverUrl,
            externalId: state.externalId,
            identityProof: state.identityProof || '',
            tags: state.tags,
            attributes: state.attributes,
            consent: state.consent,
          }, token)
        }
        notifyListeners(state.listeners.registrationChanged, token)
      }))
      await addBridgeHandle(handles, NativeCapgoNotifications.addListener('notificationReceived', (notification) => {
        void Promise.allSettled([
          applyBadgeFromNotification(notification),
          trackEvent('received', eventFromNotification(notification, 'received')),
          maybeRunUpdateCheck(notification),
        ])
        notifyListeners(state.listeners.notificationReceived, notification)
      }))
      await addBridgeHandle(handles, NativeCapgoNotifications.addListener('notificationOpened', (event) => {
        void Promise.allSettled([
          applyBadgeFromNotification(event.notification),
          trackEvent('opened', eventFromNotification(event.notification, 'opened')),
        ])
        notifyListeners(state.listeners.notificationOpened, event)
      }))
      await addBridgeHandle(handles, NativeCapgoNotifications.addListener('backgroundNotification', (notification) => {
        const isUpdateCheck = isUpdateCheckNotification(notification)
        const hasBackgroundListeners = state.listeners.backgroundNotification.size > 0
        const backgroundWork = Promise.allSettled([
          applyBadgeFromNotification(notification),
          isUpdateCheck ? maybeRunUpdateCheck(notification) : trackEvent('background_started', eventFromNotification(notification, 'background_started')),
        ])
        let finished = false
        const finish = async (result: CapgoBackgroundNotificationResult = 'newData') => {
          if (finished)
            return
          finished = true
          let completionResult = result
          try {
            const workResults = await backgroundWork
            if (completionResult === 'newData' && workResults.some(workResult => workResult.status === 'rejected'))
              completionResult = 'failed'
            if (!isUpdateCheck)
              await trackEvent('background_finished', eventFromNotification(notification, 'background_finished'))
          }
          catch {
            if (completionResult === 'newData')
              completionResult = 'failed'
          }
          finally {
            if (notification.backgroundTaskId) {
              await NativeCapgoNotifications.completeBackgroundNotification({
                backgroundTaskId: notification.backgroundTaskId,
                result: completionResult,
              }).catch(() => undefined)
            }
          }
        }
        notifyListeners(state.listeners.backgroundNotification, { notification, finish })
        if (!hasBackgroundListeners)
          void finish()
      }))
      state.bridgeListenersReady = true
    }
    catch (error) {
      await Promise.allSettled(handles.map(handle => handle.remove()))
      throw error
    }
    finally {
      state.bridgeListenersPromise = undefined
    }
  })()

  return state.bridgeListenersPromise
}

async function getUpdater(): Promise<UpdaterPlugin | null> {
  if (!Capacitor.isPluginAvailable('CapacitorUpdater'))
    return null
  return registerPlugin<UpdaterPlugin>('CapacitorUpdater')
}

export const CapgoNotifications: CapgoNotificationsPlugin = {
  async configure(config) {
    state.config = config
    state.updater.enabled = config.autoUpdater !== false
    state.updater.installMode = config.updateInstallMode || 'next'
    state.updater.channel = config.updateChannel
    hydrateStoredRegistration(config.appId)
    hydrateStoredBadgeState(config.appId)
    await hydrateNativeBadge(config.appId)
    await ensureBridgeListeners()
    if (Capacitor.getPlatform() === 'android')
      await NativeCapgoNotifications.createDefaultChannel().catch(() => undefined)
    await flushEventQueue(config.appId)
    await syncBadgeWithServer(config.appId).catch(() => undefined)
  },

  async register(options) {
    state.externalId = options.externalId
    state.identityProof = options.identityProof
    state.tags = options.tags ?? state.tags
    state.attributes = options.attributes ?? state.attributes
    state.consent = options.consent ?? state.consent
    state.config = {
      appId: options.appId || state.config?.appId || '',
      serverUrl: options.serverUrl || state.config?.serverUrl,
      autoUpdater: state.updater.enabled,
      updateInstallMode: state.updater.installMode,
      updateChannel: state.updater.channel,
    }
    await ensureBridgeListeners()
    const token = state.token || await requestToken()
    return registerToken(options, token)
  },

  async setExternalId(externalId, identityProof) {
    if (externalId !== state.externalId && !identityProof)
      throw new Error('Capgo notification identityProof is required when externalId changes')
    state.externalId = externalId
    state.identityProof = identityProof ?? state.identityProof
    if (state.token)
      await registerToken({ externalId, identityProof: state.identityProof || '', tags: state.tags, attributes: state.attributes, consent: state.consent }, state.token)
  },

  async setTags(tags) {
    state.tags = tags
    if (state.token && state.externalId)
      await registerToken({ externalId: state.externalId, identityProof: state.identityProof || '', tags, attributes: state.attributes, consent: state.consent }, state.token)
  },

  async setBadge(count) {
    await applyBadge(count)
    if (state.token && state.externalId)
      await registerToken({ externalId: state.externalId, identityProof: state.identityProof || '', tags: state.tags, attributes: state.attributes, consent: state.consent }, state.token)
    await trackEvent('badge_applied', { badge: state.badge, badgeRevision: state.badgeRevision }).catch(() => undefined)
  },

  async clearBadge() {
    state.badgeRevision = Math.max(state.badgeRevision, Date.now())
    state.badge = 0
    await NativeCapgoNotifications.clearBadge()
    if (state.config?.appId)
      writeStoredBadgeState(state.config.appId)
    if (state.token && state.externalId)
      await registerToken({ externalId: state.externalId, identityProof: state.identityProof || '', tags: state.tags, attributes: state.attributes, consent: state.consent }, state.token)
    await trackEvent('badge_applied', { badge: state.badge, badgeRevision: state.badgeRevision }).catch(() => undefined)
  },

  async incrementBadge(by = 1) {
    const current = await NativeCapgoNotifications.getBadge().catch(() => ({ count: state.badge }))
    await this.setBadge(Math.max(0, Math.trunc(current.count + by)))
  },

  async sync() {
    return syncBadgeWithServer()
  },

  async enableUpdaterIntegration(options) {
    state.updater.enabled = options?.enabled ?? true
    state.updater.installMode = options?.installMode || state.updater.installMode
    state.updater.channel = options?.channel ?? state.updater.channel
  },

  async runUpdateCheck(options): Promise<CapgoUpdateCheckResult> {
    const enabled = options?.enabled ?? state.updater.enabled
    if (!enabled)
      return { status: 'disabled' }
    const updater = await getUpdater()
    if (!updater)
      return { status: 'unavailable', error: 'CapacitorUpdater plugin is not installed' }
    try {
      const installMode = options?.installMode || state.updater.installMode
      const channel = options?.channel || state.updater.channel
      if (updater.triggerUpdateCheck) {
        return normalizeUpdaterResult(await updater.triggerUpdateCheck({
          channel,
          installMode,
        }))
      }
      const latest = await updater.getLatest({ channel })
      if (!latest.url)
        return { status: 'no_update', version: latest.version, error: latest.message || latest.error }
      const bundle = await updater.download({
        url: latest.url,
        version: latest.version,
        checksum: latest.checksum,
        sessionKey: latest.sessionKey,
        manifest: latest.manifest,
      })
      if (installMode === 'set')
        await updater.set({ id: bundle.id })
      else
        await updater.next({ id: bundle.id })
      return { status: 'installed', version: latest.version, bundleId: bundle.id }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Update check failed'
      if (message === 'No new version available' || message.includes('no_new_version_available'))
        return { status: 'no_update', error: message }
      return { status: 'failed', error: message }
    }
  },

  async trackReceived(event) {
    await trackEvent('received', event)
  },

  async trackOpened(event) {
    await trackEvent('opened', event)
  },

  async addListener(eventName, listenerFunc) {
    await ensureBridgeListeners()
    if (eventName === 'notificationReceived') {
      const listener = listenerFunc as (notification: CapgoPushNotificationSchema) => void
      state.listeners.notificationReceived.add(listener)
      return createListenerHandle(() => state.listeners.notificationReceived.delete(listener))
    }

    if (eventName === 'notificationOpened') {
      const listener = listenerFunc as (event: CapgoNotificationOpenedEvent) => void
      state.listeners.notificationOpened.add(listener)
      return createListenerHandle(() => state.listeners.notificationOpened.delete(listener))
    }

    if (eventName === 'backgroundNotification') {
      const listener = listenerFunc as (event: CapgoBackgroundNotificationEvent) => void
      state.listeners.backgroundNotification.add(listener)
      return createListenerHandle(() => state.listeners.backgroundNotification.delete(listener))
    }

    const listener = listenerFunc as (token: CapgoNotificationToken) => void
    state.listeners.registrationChanged.add(listener)
    return createListenerHandle(() => state.listeners.registrationChanged.delete(listener))
  },
}
