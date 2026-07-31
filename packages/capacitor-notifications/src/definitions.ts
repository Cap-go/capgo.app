import type { PermissionState, PluginListenerHandle } from '@capacitor/core'

export type CapgoNotificationPermission = 'unknown' | 'prompt' | 'granted' | 'denied'
export type CapgoNotificationPlatform = 'ios' | 'android'
export type CapgoNotificationInstallMode = 'next' | 'set'
export type CapgoNotificationImportance = 1 | 2 | 3 | 4 | 5
export type CapgoNotificationVisibility = -1 | 0 | 1
export type CapgoBackgroundNotificationResult = 'newData' | 'noData' | 'failed'

export interface CapgoNotificationsConfig {
  appId: string
  serverUrl?: string
  autoUpdater?: boolean
  updateInstallMode?: CapgoNotificationInstallMode
  updateChannel?: string
}

export interface CapgoNotificationRegisterOptions {
  appId?: string
  serverUrl?: string
  externalId: string
  identityProof: string
  tags?: string[]
  attributes?: Record<string, unknown>
  consent?: boolean
  appVersion?: string
}

export interface CapgoNotificationRegistration {
  recipientKey: string
  deviceKey: string
  bucket: string
  token: string
  platform: CapgoNotificationPlatform
  permission: CapgoNotificationPermission
  eventProof: string
  badgeRevision?: number
}

export interface CapgoNotificationEvent {
  appId?: string
  campaignId?: string
  notificationId?: string
  eventId?: string
  occurredAt?: string
  externalId?: string
  nativeInstallId?: string
  recipientKey?: string
  deviceKey?: string
  eventProof?: string
  platform?: CapgoNotificationPlatform
  error?: string
  badge?: number
  badgeRevision?: number
}

export interface CapgoPushNotificationSchema {
  title?: string
  subtitle?: string
  body?: string
  id: string
  backgroundTaskId?: string
  tag?: string
  badge?: number
  data: Record<string, unknown>
  click_action?: string
  link?: string
  group?: string
  groupSummary?: boolean
}

export interface CapgoNotificationOpenedEvent {
  notification: CapgoPushNotificationSchema
  actionId?: string
  inputValue?: string
}

export interface CapgoBackgroundNotificationEvent {
  notification: CapgoPushNotificationSchema
  finish: (result?: CapgoBackgroundNotificationResult) => Promise<void>
}

export interface CapgoNotificationToken {
  value: string
}

export interface CapgoNotificationRegistrationError {
  error: string
}

export interface CapgoNotificationChannel {
  id: string
  name: string
  description?: string
  sound?: string
  importance?: CapgoNotificationImportance
  visibility?: CapgoNotificationVisibility
  lights?: boolean
  lightColor?: string
  vibration?: boolean
  showBadge?: boolean
}

export interface CapgoNotificationChannelList {
  channels: CapgoNotificationChannel[]
}

export interface CapgoDeliveredNotifications {
  notifications: CapgoPushNotificationSchema[]
}

export interface CapgoBadgeResult {
  count: number
}

export interface CapgoNativeInstallIdResult {
  nativeInstallId: string
}

export interface CapgoNativeAppInfo {
  version?: string
  build?: string
  name?: string
  id?: string
}

export interface CapgoNotificationPermissionStatus {
  receive: PermissionState | CapgoNotificationPermission
}

export interface CapgoUpdaterIntegrationOptions {
  enabled?: boolean
  installMode?: CapgoNotificationInstallMode
  channel?: string
}

export interface CapgoUpdateCheckResult {
  status: 'disabled' | 'unavailable' | 'no_update' | 'installed' | 'failed'
  version?: string
  bundleId?: string
  error?: string
}

export interface CapgoNotificationSyncResult {
  badge?: number
  badgeRevision?: number
  appliedBadge?: boolean
  pendingEvents?: number
}

export interface CapgoBackgroundNotificationCompletion {
  backgroundTaskId?: string
  result?: CapgoBackgroundNotificationResult
}

export interface CapgoBackgroundNotificationCompletionResult {
  completed?: boolean
}

export interface CapgoNotificationsNativePlugin {
  checkPermissions: () => Promise<CapgoNotificationPermissionStatus>
  requestPermissions: () => Promise<CapgoNotificationPermissionStatus>
  registerPush: () => Promise<void>
  unregisterPush: () => Promise<void>
  setBadge: (options: { count: number }) => Promise<CapgoBadgeResult>
  clearBadge: () => Promise<CapgoBadgeResult>
  getBadge: () => Promise<CapgoBadgeResult>
  getNativeInstallId: () => Promise<CapgoNativeInstallIdResult>
  getAppInfo: () => Promise<CapgoNativeAppInfo>
  createDefaultChannel: (channel?: Partial<CapgoNotificationChannel>) => Promise<void>
  createChannel: (channel: CapgoNotificationChannel) => Promise<void>
  deleteChannel: (options: { id: string }) => Promise<void>
  listChannels: () => Promise<CapgoNotificationChannelList>
  getDeliveredNotifications: () => Promise<CapgoDeliveredNotifications>
  removeDeliveredNotifications: (delivered: CapgoDeliveredNotifications) => Promise<void>
  removeAllDeliveredNotifications: () => Promise<void>
  completeBackgroundNotification: (options: CapgoBackgroundNotificationCompletion) => Promise<CapgoBackgroundNotificationCompletionResult>
  addListener: {
    (eventName: 'registration', listenerFunc: (token: CapgoNotificationToken) => void): Promise<PluginListenerHandle>
    (eventName: 'registrationError', listenerFunc: (error: CapgoNotificationRegistrationError) => void): Promise<PluginListenerHandle>
    (eventName: 'notificationReceived', listenerFunc: (notification: CapgoPushNotificationSchema) => void): Promise<PluginListenerHandle>
    (eventName: 'notificationOpened', listenerFunc: (event: CapgoNotificationOpenedEvent) => void): Promise<PluginListenerHandle>
    (eventName: 'backgroundNotification', listenerFunc: (event: CapgoPushNotificationSchema) => void): Promise<PluginListenerHandle>
  }
  removeAllListeners: () => Promise<void>
}

export interface CapgoNotificationsPlugin {
  configure: (config: CapgoNotificationsConfig) => Promise<void>
  register: (options: CapgoNotificationRegisterOptions) => Promise<CapgoNotificationRegistration>
  setExternalId: (externalId: string, identityProof?: string) => Promise<void>
  setTags: (tags: string[]) => Promise<void>
  setBadge: (count: number) => Promise<void>
  clearBadge: () => Promise<void>
  incrementBadge: (by?: number) => Promise<void>
  sync: () => Promise<CapgoNotificationSyncResult>
  enableUpdaterIntegration: (options?: CapgoUpdaterIntegrationOptions) => Promise<void>
  runUpdateCheck: (options?: CapgoUpdaterIntegrationOptions) => Promise<CapgoUpdateCheckResult>
  trackReceived: (event?: CapgoNotificationEvent) => Promise<void>
  trackOpened: (event?: CapgoNotificationEvent) => Promise<void>
  addListener: {
    (eventName: 'notificationReceived', listenerFunc: (notification: CapgoPushNotificationSchema) => void): Promise<PluginListenerHandle>
    (eventName: 'notificationOpened', listenerFunc: (event: CapgoNotificationOpenedEvent) => void): Promise<PluginListenerHandle>
    (eventName: 'backgroundNotification', listenerFunc: (event: CapgoBackgroundNotificationEvent) => void): Promise<PluginListenerHandle>
    (eventName: 'registrationChanged', listenerFunc: (token: CapgoNotificationToken) => void): Promise<PluginListenerHandle>
  }
}
