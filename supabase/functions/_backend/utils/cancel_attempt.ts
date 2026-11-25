import type { Context } from 'hono'
import type { CancelFeedback } from './stripe_in_app.ts'
import { cloudlogErr } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'

// Records each cancel attempt that reaches the offer step in public.cancel_attempts,
// so the admin dashboard can measure every outcome: the discount or credits offer,
// the call with the founder, or no offer at all. Recording never blocks the cancel
// flow: a failure is logged and the customer goes on.

// Reasons a conversation can solve better than a price: the cancel flow offers a
// call with the founder before canceling.
export const FOUNDER_CALL_REASONS: readonly CancelFeedback[] = ['missing_features', 'switched_service', 'too_complex', 'low_quality', 'customer_service']

export function showsFounderCall(reason: CancelFeedback) {
  return FOUNDER_CALL_REASONS.includes(reason)
}

async function run<T>(c: Context, message: string, query: string, values: unknown[]): Promise<T[]> {
  try {
    const pg = await getPgClient(c)
    try {
      return (await pg.query(query, values)).rows as T[]
    }
    finally {
      await closeClient(c, pg)
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message, error })
    return []
  }
}

/** The new attempt id, or null when it could not be recorded. */
export async function recordCancelAttempt(c: Context, attempt: { orgId: string, customerId: string, reason: CancelFeedback, offerId: string | null, founderCall: boolean }) {
  const rows = await run<{ id: string }>(
    c,
    'cancel attempt record failed',
    `INSERT INTO public.cancel_attempts (org_id, customer_id, reason, offer_id, founder_call_shown)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [attempt.orgId, attempt.customerId, attempt.reason, attempt.offerId, attempt.founderCall],
  )
  return rows[0]?.id ?? null
}

// Both updates are scoped to the caller's org, so an attempt id alone changes nothing elsewhere.
export async function recordFounderCallClick(c: Context, orgId: string, attemptId: string) {
  await run(
    c,
    'cancel attempt founder click failed',
    `UPDATE public.cancel_attempts SET founder_call_clicked_at = now()
     WHERE id = $1 AND org_id = $2 AND founder_call_shown AND founder_call_clicked_at IS NULL`,
    [attemptId, orgId],
  )
}

export async function recordCancelAttemptCanceled(c: Context, orgId: string, attemptId: string) {
  await run(
    c,
    'cancel attempt canceled failed',
    `UPDATE public.cancel_attempts SET canceled_at = now() WHERE id = $1 AND org_id = $2 AND canceled_at IS NULL`,
    [attemptId, orgId],
  )
}
