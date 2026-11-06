import { createHono, parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { createNotificationIdentityProof } from '../utils/nativeNotifications.ts'
import { getEnv } from '../utils/utils.ts'
import { version } from '../utils/version.ts'

/** Capgo's own mobile app. Override with NOTIFICATIONS_SELF_APP_IDS (comma-separated) for self-hosted builds. */
export const DEFAULT_SELF_NOTIFICATION_APP_IDS = ['ee.forgr.capacitor_go']

interface SelfProofBody {
  appId?: string
}

export function getSelfNotificationAppIds(rawEnv: string | undefined): string[] {
  const configured = (rawEnv ?? '').split(',').map(appId => appId.trim()).filter(Boolean)
  return configured.length ? configured : DEFAULT_SELF_NOTIFICATION_APP_IDS
}

export const app = createHono('private/notification_self_proof', version)
app.use('*', useCors)

/**
 * Mint a native notification identity proof for the signed-in user on Capgo's
 * own mobile app. The proof binds to the caller's user id, so a user can only
 * register their own devices, and only for the allow-listed Capgo app ids.
 */
app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<SelfProofBody>(c)
  const appIds = getSelfNotificationAppIds(getEnv(c, 'NOTIFICATIONS_SELF_APP_IDS'))
  const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
  if (!appIds.includes(appId))
    throw simpleError('invalid_app_id', 'Notifications are not available for this app', { app_id: appId })
  const externalId = c.get('auth')?.userId
  if (!externalId)
    throw simpleError('invalid_jwt', 'Invalid JWT')
  return c.json({ appId, externalId, identityProof: await createNotificationIdentityProof(c, appId, externalId) })
})
