import type { Context } from 'hono'
import type { EmailPreferences } from './org_email_notifications.ts'
import { syncBentoSubscriberTags, updateBentoFields } from './bento.ts'
import { cloudlog } from './logging.ts'

/** Bento audience tag for security update email subscribers. */
export const SECURITY_UPDATES_BENTO_TAG = 'security-updates'

/** Bento subscriber custom field mirroring security_updates email opt-in. */
export const SECURITY_UPDATES_BENTO_OPT_IN_FIELD = 'security_updates_opt_in'

export function isSecurityUpdatesEmailOptIn(prefs: EmailPreferences | null | undefined): boolean {
  return prefs?.security_updates === true
}

export async function syncSecurityUpdatesBento(
  c: Context,
  email: string,
  prefs: EmailPreferences | null | undefined,
  previousPrefs?: EmailPreferences | null,
) {
  const enabled = isSecurityUpdatesEmailOptIn(prefs)
  const previousEnabled = isSecurityUpdatesEmailOptIn(previousPrefs)
  if (enabled === previousEnabled)
    return
  try {
    await syncBentoSubscriberTags(c, {
      email,
      segments: enabled ? [SECURITY_UPDATES_BENTO_TAG] : [],
      deleteSegments: enabled ? [] : [SECURITY_UPDATES_BENTO_TAG],
    })
    await updateBentoFields(c, email, { [SECURITY_UPDATES_BENTO_OPT_IN_FIELD]: enabled })
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'syncSecurityUpdatesBento error', error })
  }
}
