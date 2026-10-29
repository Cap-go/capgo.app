import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import type { UsageOverageEventRow } from '../utils/credit_usage_posthog.ts'
import { buildCreditUsagePosthogEventInput, getCreditUsageSourceRefOverageEventId } from '../utils/credit_usage_posthog.ts'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { queryJsonOne } from '../utils/pg_rls.ts'
import { trackPosthogEvent } from '../utils/posthog.ts'

interface CreditUsagePosthogPayload {
  transaction_id?: number | string
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const payload = await parseBody<CreditUsagePosthogPayload>(c)
  const transactionId = Number(payload.transaction_id)

  if (!Number.isInteger(transactionId) || transactionId <= 0)
    throw simpleError('invalid_payload', 'Missing transaction_id in credit usage PostHog payload', { payload })

  const pg = await getPgClient(c)
  let transaction: Database['public']['Tables']['usage_credit_transactions']['Row'] | null
  let overageEvent: UsageOverageEventRow | null = null
  try {
    try {
      transaction = await queryJsonOne<Database['public']['Tables']['usage_credit_transactions']['Row']>(
        pg,
        'SELECT * FROM public.usage_credit_transactions WHERE id = $1',
        [transactionId],
      )
    }
    catch (transactionError) {
      throw simpleError('transaction_lookup_failed', 'Failed to load usage credit transaction', { transactionId, error: transactionError })
    }

    if (!transaction) {
      cloudlog({ requestId: c.get('requestId'), message: 'usage credit transaction not found, skipping PostHog event', transactionId })
      return c.json(BRES)
    }

    const overageEventId = getCreditUsageSourceRefOverageEventId(transaction.source_ref)
    if (overageEventId) {
      try {
        overageEvent = await queryJsonOne<UsageOverageEventRow>(
          pg,
          'SELECT * FROM public.usage_overage_events WHERE id = $1',
          [overageEventId],
        )
      }
      catch (error) {
        throw simpleError('overage_lookup_failed', 'Failed to load usage overage event', { transactionId, overageEventId, error })
      }
    }
  }
  finally {
    closeClient(c, pg)
  }

  const eventInput = buildCreditUsagePosthogEventInput(transaction, overageEvent, 'backend')
  const sent = await trackPosthogEvent(c, {
    channel: eventInput.channel,
    description: eventInput.description,
    event: eventInput.event,
    groups: eventInput.groups,
    setPersonProperties: false,
    tags: eventInput.tags,
    timestamp: eventInput.timestamp,
    user_id: eventInput.distinctId,
  })

  cloudlog({
    requestId: c.get('requestId'),
    message: sent ? 'credit usage PostHog event sent' : 'credit usage PostHog event skipped',
    transactionId,
    orgId: transaction.org_id,
  })

  return c.json(BRES)
})
