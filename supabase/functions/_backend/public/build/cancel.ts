import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { TERMINAL_BUILD_STATUSES } from '../../utils/build_timeout.ts'
import { simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import type { PgClient } from '../../utils/pg.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { apikeyPrincipal, queryJson, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { getEnv } from '../../utils/utils.ts'

export async function cancelBuild(
  c: Context,
  jobId: string,
  appId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  if (!(await checkPermission(c, 'app.build_native', { appId }))) {
    const errorMsg = 'You do not have permission to cancel builds for this app'
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unauthorized cancel build',
      job_id: jobId,
      app_id: appId,
      user_id: apikey.user_id,
    })
    throw simpleError('unauthorized', errorMsg)
  }

  // Bind jobId to its request owner before calling the builder.
  const principal = apikeyPrincipal(c, apikey.key)
  let buildRequest: { app_id: string } | null
  try {
    const rows = await withRlsContext(c, principal, client => queryJson<{ app_id: string }>(
      client,
      'SELECT app_id FROM public.build_requests WHERE builder_job_id = $1 AND app_id = $2 LIMIT 2',
      [jobId, appId],
    ))
    // maybeSingle(): more than one row was an error under PostgREST
    if (rows.length > 1)
      throw new Error('JSON object requested, multiple (or no) rows returned')
    buildRequest = rows[0] ?? null
  }
  catch (buildRequestError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to fetch build_request for cancel build',
      job_id: jobId,
      error: buildRequestError instanceof Error ? buildRequestError.message : String(buildRequestError),
    })
    throw simpleError('internal_error', 'Failed to fetch build request')
  }

  if (!buildRequest) {
    const errorMsg = 'You do not have permission to cancel builds for this app'
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unauthorized cancel build (job/app mismatch or missing)',
      job_id: jobId,
      app_id: appId,
      user_id: apikey.user_id,
    })
    throw simpleError('unauthorized', errorMsg)
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Cancel build request',
    job_id: jobId,
    app_id: appId,
    user_id: apikey.user_id,
  })

  // Call builder to cancel the job
  const builderResponse = await fetch(`${getEnv(c, 'BUILDER_URL')}/jobs/${jobId}/cancel`, {
    method: 'POST',
    headers: {
      'x-api-key': getEnv(c, 'BUILDER_API_KEY'),
    },
  })

  if (!builderResponse.ok) {
    const errorText = await builderResponse.text()
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Builder cancel failed',
      job_id: jobId,
      status: builderResponse.status,
      error: errorText,
    })
    throw simpleError('builder_error', `Failed to cancel build: ${errorText}`)
  }

  const builderResult = await builderResponse.json() as { jobId: string, status: string, message?: string }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Build cancelled',
    job_id: jobId,
    status: builderResult.status,
  })

  // Update build_requests status to cancelled so the concurrency slot is freed immediately.
  // Use admin client: access was already verified above (RLS SELECT + checkPermission).
  // build_requests has no UPDATE policy for anon/authenticated, so the API-key client
  // would silently update 0 rows. Only non-terminal rows are moved to cancelled.
  let pg: PgClient | null = null
  try {
    pg = await getPgClient(c)
    await pg.query(
      `UPDATE public.build_requests
      SET status = 'cancelled', updated_at = $3
      WHERE builder_job_id = $1 AND app_id = $2 AND NOT (status = ANY($4::text[]))`,
      [jobId, appId, new Date().toISOString(), [...TERMINAL_BUILD_STATUSES]],
    )
  }
  catch (updateError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to update build_requests status to cancelled',
      job_id: jobId,
      error: updateError instanceof Error ? updateError.message : String(updateError),
    })
  }
  finally {
    if (pg)
      closeClient(c, pg)
  }

  return c.json({
    job_id: jobId,
    status: builderResult.status,
    message: builderResult.message || 'Build cancelled',
  }, 200)
}
