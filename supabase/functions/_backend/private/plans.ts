import type { Database } from '../utils/supabase.types.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { bytesToGb } from '../utils/conversion.ts'
import { useCors } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { queryJson } from '../utils/pg_rls.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.get('/', async (c) => {
  let plans: Database['public']['Tables']['plans']['Row'][] | null = null
  const pg = await getPgClient(c)
  try {
    plans = await queryJson<Database['public']['Tables']['plans']['Row']>(pg, 'SELECT * FROM public.plans ORDER BY price_m')
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'plans query failed', error })
  }
  finally {
    closeClient(c, pg)
  }
  // use bytesToGb function to convert all column storage and bandwidth to GB
  const plansGb = plans?.map((plan) => {
    plan.storage = bytesToGb(plan.storage)
    plan.bandwidth = bytesToGb(plan.bandwidth)
    return plan
  })
  return c.json(plansGb ?? [])
})
