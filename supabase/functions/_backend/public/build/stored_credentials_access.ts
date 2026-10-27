import type { Context } from 'hono'
import { quickError } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'

/**
 * Stored signing secrets are written only by app admins (app.update_settings). The project
 * archive of a build runs arbitrary Gradle/Podfile/npm scripts with those secrets in env, so
 * a build that injects them needs the same right; app.build_native alone is not enough.
 */
export const STORED_CREDENTIALS_BUILD_PERMISSION = 'app.update_settings' as const

export async function ensureStoredCredentialsPermission(c: Context, appId: string, userId: string) {
  if (await checkPermission(c, STORED_CREDENTIALS_BUILD_PERMISSION, { appId }))
    return
  cloudlog({
    requestId: c.get('requestId'),
    message: 'Stored build credentials denied: missing app.update_settings',
    app_id: appId,
    user_id: userId,
  })
  throw quickError(403, 'permission_denied', 'Capgo permission denied: building with the app\'s stored credentials (use_stored_credentials) requires app admin rights (app.update_settings), because build scripts can read the signing secrets. Ask an app admin to run this build, or provide the signing credentials directly instead of using the stored ones.', {
    app_id: appId,
    permission: STORED_CREDENTIALS_BUILD_PERMISSION,
  }, undefined, { alert: false })
}
