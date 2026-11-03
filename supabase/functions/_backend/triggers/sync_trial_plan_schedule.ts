import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { syncTrialPlanScheduleForCustomer } from '../utils/stripe_trial_plan.ts'

interface SyncBody {
  customerId?: string
  trialAt?: string | null
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<SyncBody>(c)
  if (!body.customerId)
    throw simpleError('invalid_body', 'Missing customerId')
  if (body.trialAt !== undefined && body.trialAt !== null && Number.isNaN(Date.parse(body.trialAt)))
    throw simpleError('invalid_body', 'Invalid trialAt')

  try {
    const result = await syncTrialPlanScheduleForCustomer(c, body.customerId, body.trialAt)
    cloudlog({ requestId: c.get('requestId'), message: 'sync_trial_plan_schedule', customerId: body.customerId, result })
    if (result === 'failed')
      throw simpleError('trial_plan_schedule_sync_failed', 'Trial plan schedule sync failed')
    return c.json({ ...BRES, result })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'sync_trial_plan_schedule failed', customerId: body.customerId, error })
    throw error
  }
})
