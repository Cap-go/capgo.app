import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { quickError, useCors } from '../utils/hono.ts'
import { validatePlatformAdminOrApiSecret } from '../utils/platform_admin_access.ts'
import { buildAdminSecurityUpdatesTracking } from '../utils/security_advisory_admin_tracking.ts'
import { SecurityAdvisoryFeedUnavailableError } from '../utils/security_advisory_feed.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

async function requirePlatformAdmin(c: Parameters<typeof validatePlatformAdminOrApiSecret>[0]) {
  await validatePlatformAdminOrApiSecret(c, {
    logPrefix: 'admin_security_updates',
    forbiddenMessage: 'Platform admin access is required',
  })
}

app.get('/tracking', async (c) => {
  await requirePlatformAdmin(c)
  try {
    const body = await buildAdminSecurityUpdatesTracking(c)
    return c.json(body)
  }
  catch (error) {
    if (error instanceof SecurityAdvisoryFeedUnavailableError)
      throw quickError(503, 'advisory_feed_unavailable', 'Security advisory feed is temporarily unavailable')
    throw error
  }
})
