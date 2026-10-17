import type { Context } from 'hono'
import { cloudlog } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'

// Only called after the authenticated build-request path has actually denied
// its build-time allowance. Missing builds or checklist warnings are not proof.
export async function recordLifecycleFundingDenial(c: Context, orgId: string, appId: string) {
  let pg: Awaited<ReturnType<typeof getPgClient>> | undefined
  try {
    pg = await getPgClient(c)
    await pg.query(`WITH denied AS (
      UPDATE public.bento_lifecycle_app_observations obs SET verified = obs.verified ||
        pg_catalog.jsonb_build_object('fundingDeniedAt', CURRENT_TIMESTAMP)
      FROM public.apps a WHERE a.app_id = $2 AND a.owner_org = $1::uuid
        AND obs.org_id = a.owner_org AND obs.app_incarnation = a.id AND obs.product = 'builder'
      RETURNING obs.org_id
    ) UPDATE public.bento_lifecycle_journeys j SET candidate = NULL, revision = revision + 1,
      next_evaluation_at = CURRENT_TIMESTAMP FROM denied WHERE j.org_id = denied.org_id AND j.product = 'builder'`, [orgId, appId])
  }
  catch {
    // Guidance telemetry must not change the original billing-denial response.
    cloudlog({ requestId: c.get('requestId'), message: 'Lifecycle funding evidence unavailable' })
  }
  finally {
    if (pg) {
      try {
        await closeClient(c, pg)
      }
      catch { cloudlog({ requestId: c.get('requestId'), message: 'Lifecycle funding cleanup unavailable' }) }
    }
  }
}
