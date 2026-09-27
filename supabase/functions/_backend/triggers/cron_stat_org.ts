import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { checkPlanStatusOnly } from '../utils/plans.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

interface OrgToGet {
  orgId?: string
  customerId?: string
  statsTargetAt?: string
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<OrgToGet>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post cron_stat_org body', body })
  if (!body.orgId)
    throw simpleError('no_orgId', 'No orgId', { body })

  // `checkPlanStatusOnly()` may refresh the org metrics cache through
  // `get_plan_usage_and_fit_uncached()`, so this path must use a write-capable
  // transaction instead of a read-only pool.
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  try {
    try {
      await checkPlanStatusOnly(c, body.orgId, drizzleClient)
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'checkPlanStatusOnly failed', orgId: body.orgId, error })
      throw error
    }

    // Update plan_calculated_at timestamp if we have customerId
    if (body.customerId) {
      try {
        const supabase = supabaseAdmin(c)
        await supabase
          .from('stripe_info')
          .update({ plan_calculated_at: new Date().toISOString() })
          .eq('customer_id', body.customerId)
          .throwOnError()

        cloudlog({ requestId: c.get('requestId'), message: 'plan calculated timestamp updated', customerId: body.customerId })
      }
      catch (error) {
        cloudlog({ requestId: c.get('requestId'), message: 'plan calculated timestamp update failed', customerId: body.customerId, error })
      }
    }
    await pgClient.query(
      'SELECT public.mark_org_stats_refreshed($1, $2::timestamp without time zone)',
      [body.orgId, body.statsTargetAt ?? null],
    )
    cloudlog({
      requestId: c.get('requestId'),
      message: 'org stats refresh marked complete',
      orgId: body.orgId,
      statsTargetAt: body.statsTargetAt,
    })

    return c.json(BRES)
  }
  finally {
    closeClient(c, pgClient)
  }
})
