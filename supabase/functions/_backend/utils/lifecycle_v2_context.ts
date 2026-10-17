import type { Context } from 'hono'
import { cloudlog } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'

// The events endpoint has already checked app.read and the app's owning org.
// Selection updates evidence context only; it is never meaningful progress.
export async function selectLifecycleApp(c: Context, orgId: string, appId: string, incarnation: unknown, product: unknown) {
  if (typeof incarnation !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(incarnation)
    || (product !== 'ota' && product !== 'builder')) {
    return false
  }
  let pg: Awaited<ReturnType<typeof getPgClient>> | undefined
  try {
    pg = await getPgClient(c)
    const result = await pg.query(`WITH selected AS (
      UPDATE public.bento_lifecycle_journeys j SET selected_app_incarnation = a.id,
        candidate = NULL, revision = j.revision + 1, next_evaluation_at = CURRENT_TIMESTAMP
      FROM public.apps a WHERE j.org_id = $1::uuid AND j.product = $4
        AND a.app_id = $2 AND a.id = $3::uuid AND a.owner_org = j.org_id
        AND a.onboarding #>> '{setup,todo_list_version}' = '4'
        AND (a.onboarding #>> '{setup,selected_path}' = j.product
          OR a.onboarding #> '{setup,paths}' = pg_catalog.jsonb_build_array(j.product))
        AND j.selected_app_incarnation IS DISTINCT FROM a.id
      RETURNING j.org_id, j.product
    ) UPDATE public.bento_lifecycle_app_observations obs SET acknowledged_before = CURRENT_TIMESTAMP
      FROM selected WHERE obs.org_id = selected.org_id AND obs.product = selected.product AND obs.app_incarnation = $3::uuid`, [orgId, appId, incarnation, product])
    return !!result.rowCount
  }
  catch {
    cloudlog({ requestId: c.get('requestId'), message: 'Lifecycle app selection unavailable' })
    return false
  }
  finally {
    if (pg)
      await closeClient(c, pg)
  }
}
