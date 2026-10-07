import type { CapgoBackgroundNotificationEvent, CapgoBackgroundNotificationResult, CapgoNotificationInstallMode } from '@capgo/capacitor-notifications'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { CapgoNotifications } from '@capgo/capacitor-notifications'
import { invokeCapgoApi } from '~/services/capgoApi'
import { defaultApiHost } from '~/services/supabase'

interface SelfProofResponse {
  appId: string
  externalId: string
  identityProof: string
}

const UPDATE_CHECK_ACTIONS = new Set(['update_check', 'capgo_update_check'])

let setupPromise: Promise<string | null> | null = null
let registeredUserId: string | null = null
let registeringUserId: string | null = null

function getStringData(data: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = data?.[key]
    if (typeof value === 'string' && value.trim())
      return value.trim()
  }
  return ''
}

function isUpdateCheckNotification(data: Record<string, unknown> | undefined) {
  return UPDATE_CHECK_ACTIONS.has(getStringData(data, 'capgoAction', 'capgo_action'))
}

/**
 * Never reload the WebView under a user who is looking at the app: queue the
 * bundle for the next background instead. When the app was woken in the
 * background (or the user is in another app), apply it right away so the next
 * open already runs the new version.
 */
export function resolveUpdateInstallMode(requested: string, appIsActive: boolean): CapgoNotificationInstallMode {
  if (appIsActive)
    return 'next'
  return requested === 'next' ? 'next' : 'set'
}

async function isAppActive() {
  try {
    return (await App.getState()).isActive
  }
  catch {
    return true
  }
}

async function handleBackgroundNotification({ notification, finish }: CapgoBackgroundNotificationEvent) {
  let result: CapgoBackgroundNotificationResult = 'noData'
  try {
    if (!isUpdateCheckNotification(notification.data))
      return
    // Plugin 8.x runs the updater natively and reports it here: nothing left to do.
    const nativeStatus = getStringData(notification.data, 'capgoNativeUpdateCheck')
    if (nativeStatus && nativeStatus !== 'unsupported') {
      result = nativeStatus === 'queued' ? 'newData' : nativeStatus === 'failed' ? 'failed' : 'noData'
      return
    }
    const requested = getStringData(notification.data, 'capgoUpdateInstallMode', 'capgo_update_install_mode')
    // The channel in the push is ignored on purpose: the update server resolves
    // this device's own channel, so a push for another channel is a no-op here.
    const update = await CapgoNotifications.runUpdateCheck({
      enabled: true,
      installMode: resolveUpdateInstallMode(requested, await isAppActive()),
    })
    if (update.status === 'installed')
      result = 'newData'
    else if (update.status === 'failed')
      result = 'failed'
    if (update.error && update.status === 'failed')
      console.warn('Capgo push update check failed', update.error)
  }
  catch (error) {
    result = 'failed'
    console.warn('Capgo push update check failed', error)
  }
  finally {
    await finish(result).catch(() => undefined)
  }
}

async function setup(): Promise<string | null> {
  // Update checks are handled here instead of by the plugin so the device's own
  // channel is used and an active user is never interrupted by a reload. Turn
  // the plugin's handler off and attach ours before configure() starts the
  // native bridge, so a push that woke the app is never handled by the plugin.
  await CapgoNotifications.enableUpdaterIntegration({ enabled: false })
  await CapgoNotifications.addListener('backgroundNotification', (event) => {
    void handleBackgroundNotification(event)
  })
  const { id: appId } = await App.getInfo()
  await CapgoNotifications.configure({ appId, serverUrl: defaultApiHost, autoUpdater: false })
  return appId
}

/**
 * Bind native notification listeners as early as possible: a silent push can
 * cold-start the app in the background, and the listener must be attached
 * before the plugin hands the queued event to JavaScript.
 */
export function setupNativeNotifications(): Promise<string | null> {
  if (!Capacitor.isNativePlatform())
    return Promise.resolve(null)
  setupPromise ??= setup().catch((error) => {
    console.warn('Capgo notifications setup failed', error)
    setupPromise = null
    return null
  })
  return setupPromise
}

/** Register this device with Capgo native notifications for the signed-in user. */
export async function registerNativeNotifications(userId: string) {
  if (!Capacitor.isNativePlatform() || registeredUserId === userId || registeringUserId === userId)
    return
  registeringUserId = userId
  try {
    const appId = await setupNativeNotifications()
    if (!appId)
      return
    const { data, error } = await invokeCapgoApi<SelfProofResponse>('private/notification_self_proof', {
      method: 'POST',
      body: { appId },
    })
    if (error || !data?.identityProof || data.externalId !== userId)
      throw error ?? new Error('Missing notification identity proof')
    await CapgoNotifications.register({
      appId,
      serverUrl: defaultApiHost,
      externalId: data.externalId,
      identityProof: data.identityProof,
      consent: true,
    })
    registeredUserId = userId
  }
  catch (error) {
    console.warn('Capgo notifications registration failed', error)
  }
  finally {
    if (registeringUserId === userId)
      registeringUserId = null
  }
}
