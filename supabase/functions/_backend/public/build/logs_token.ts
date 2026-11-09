import type { Context } from 'hono'
import type { AuthInfo } from '../../utils/hono.ts'
import { simpleError } from '../../utils/hono.ts'
import { cloudlogErr } from '../../utils/logging.ts'
import { authPrincipal, queryJson, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { getEnv } from '../../utils/utils.ts'
import { generateLogStreamToken } from './start.ts'

const READ_TOKEN_TTL_SECONDS = 60 * 60

/**
 * Read-only access to a build's live log stream, for the console (JWT) or an API key.
 * The token carries `role: 'read'`: it can follow the stream but never start or ack it.
 */
export async function getBuildLogsToken(c: Context, jobId: string): Promise<Response> {
  const auth = c.get('auth') as AuthInfo
  let rows: { app_id: string }[]
  try {
    rows = await withRlsContext(c, authPrincipal(c, auth), client => queryJson<{ app_id: string }>(
      client,
      'SELECT app_id FROM public.build_requests WHERE builder_job_id = $1 LIMIT 2',
      [jobId],
    ))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to fetch build_request for logs token', job_id: jobId, error })
    throw simpleError('internal_error', 'Failed to fetch build request')
  }

  // Missing, ambiguous and forbidden builds all look the same so job ids do not leak.
  const appId = rows.length === 1 ? rows[0].app_id : null
  if (!appId || !(await checkPermission(c, 'app.read_logs', { appId })))
    throw simpleError('unauthorized', 'You do not have permission to view logs for this build')

  const jwtSecret = getEnv(c, 'JWT_SECRET')
  if (!jwtSecret)
    throw simpleError('config_error', 'Builder log authentication is not configured')

  const publicUrl = getEnv(c, 'PUBLIC_URL') || 'https://api.capgo.app'
  return c.json({
    logs_url: `${publicUrl}/build_logs_direct/${jobId}`,
    logs_token: await generateLogStreamToken(jobId, auth.userId, appId, jwtSecret, { role: 'read', ttlSeconds: READ_TOKEN_TTL_SECONDS }),
  })
}
