import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { AppAdvisoryFeedResponse } from '../../shared/security_advisory.ts'
import { Hono } from 'hono/tiny'
import { loadAppReportedPackages } from '../utils/app_native_packages.ts'
import { loadSecurityAdvisoryFeed } from '../utils/security_advisory_feed.ts'
import { matchAppPackagesToAdvisories } from '../utils/security_advisory_matching.ts'
import { quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { checkPermission } from '../utils/rbac.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/feed', middlewareAuth, async (c) => {
  const appId = c.req.query('app_id')?.trim() ?? ''
  if (!appId)
    throw simpleError('missing_app_id', 'app_id is required')

  if (!(await checkPermission(c, 'app.read', { appId })))
    throw quickError(403, 'app_access_denied', 'You can\'t access this app', { app_id: appId })

  const [packages, feed] = await Promise.all([
    loadAppReportedPackages(c, appId),
    loadSecurityAdvisoryFeed(c),
  ])

  const body: AppAdvisoryFeedResponse = {
    app_id: appId,
    feed,
    items: matchAppPackagesToAdvisories(packages, feed.advisories),
  }
  return c.json(body)
})
