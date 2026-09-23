import type { Context } from 'hono'
import type { OnboardingPaymentCohortData, OnboardingPaymentCohortPeriod } from './onboarding_payment_cohorts_model.ts'
import { assertOnboardingPaymentSourceComplete, ONBOARDING_PAYMENT_SOURCE_LIMIT, onboardingPaymentSourceNumber, onboardingPaymentSourceString, onboardingPaymentSourceTimestamp } from './onboarding_payment_cohorts_model.ts'
import { closeClient, getPgClient, type PgQueryClient, checkoutPgClient, releasePgClient } from './pg.ts'

export interface OnboardingPaymentQueryExecutor {
  query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

export async function queryOnboardingPaymentCohortData(executor: OnboardingPaymentQueryExecutor, period: OnboardingPaymentCohortPeriod): Promise<OnboardingPaymentCohortData> {
  const userResult = await executor.query(`
    SELECT a.id, a.created_at AS signup_at, (u.id IS NOT NULL) AS has_public_row,
           u.created_via_invite, count(*) OVER () AS total_rows
    FROM auth.users AS a
    LEFT JOIN public.users AS u ON u.id = a.id
    WHERE a.created_at >= $1::timestamptz AND a.created_at < $2::timestamptz
    ORDER BY a.created_at, a.id
    LIMIT ${ONBOARDING_PAYMENT_SOURCE_LIMIT}`, [period.start, period.cutoff])
  assertOnboardingPaymentSourceComplete(userResult.rows, 'signup source')
  const users = userResult.rows.map((row) => {
    if (typeof row.has_public_row !== 'boolean' || (row.has_public_row && typeof row.created_via_invite !== 'boolean'))
      throw new Error('Malformed signup source exclusion flag')
    return {
      id: onboardingPaymentSourceString(row.id),
      signup_at: onboardingPaymentSourceTimestamp(row.signup_at),
      has_public_row: row.has_public_row,
      created_via_invite: row.has_public_row ? row.created_via_invite as boolean : false,
    }
  })
  const userIds = [...new Set(users.filter(user => user.has_public_row && !user.created_via_invite).map(user => user.id))]
  if (!userIds.length)
    return { users, orgs: [], grants: [] }

  // Internal admin-only lookups follow indexed org creator and grant org_id paths.
  const orgResult = await executor.query(`
    SELECT id, created_by, customer_id, count(*) OVER () AS total_rows
    FROM public.orgs
    WHERE created_by = ANY($1::uuid[])
    ORDER BY id
    LIMIT ${ONBOARDING_PAYMENT_SOURCE_LIMIT}`, [userIds])
  assertOnboardingPaymentSourceComplete(orgResult.rows, 'owned org source')
  const orgs = orgResult.rows.map(row => ({
    id: onboardingPaymentSourceString(row.id),
    created_by: onboardingPaymentSourceString(row.created_by),
    customer_id: row.customer_id === null ? null : onboardingPaymentSourceString(row.customer_id),
  }))
  if (!orgs.length)
    return { users, orgs, grants: [] }
  const grantResult = await executor.query(`
    SELECT id, org_id, granted_at, credits_total, source, source_ref, count(*) OVER () AS total_rows
    FROM public.usage_credit_grants
    WHERE org_id = ANY($1::uuid[]) AND source = 'stripe_top_up' AND credits_total > 0
      AND granted_at >= $2::timestamptz
    ORDER BY org_id, granted_at, id
    LIMIT ${ONBOARDING_PAYMENT_SOURCE_LIMIT}`, [[...new Set(orgs.map(org => org.id))], period.start])
  assertOnboardingPaymentSourceComplete(grantResult.rows, 'credit grant source')
  const grants = grantResult.rows.map((row) => {
    const ref = row.source_ref
    if (ref !== null && (typeof ref !== 'object' || Array.isArray(ref)))
      throw new Error('Malformed credit grant source reference')
    const paymentIntent = (ref as Record<string, unknown> | null)?.paymentIntentId
    const credits = onboardingPaymentSourceNumber(row.credits_total)
    if (credits <= 0 || row.source !== 'stripe_top_up')
      throw new Error('Malformed credit grant source eligibility')
    return {
      id: onboardingPaymentSourceString(row.id),
      org_id: onboardingPaymentSourceString(row.org_id),
      granted_at: onboardingPaymentSourceTimestamp(row.granted_at),
      credits_total: credits,
      source: 'stripe_top_up',
      payment_intent_id: paymentIntent === undefined || paymentIntent === null ? null : onboardingPaymentSourceString(paymentIntent),
    }
  })
  return { users, orgs, grants }
}

export async function loadOnboardingPaymentCohortData(c: Context, period: OnboardingPaymentCohortPeriod): Promise<OnboardingPaymentCohortData> {
  // auth.users is not replicated: false deliberately selects the primary connection.
  const pool = await getPgClient(c, false)
  let client: PgQueryClient | undefined
  try {
    client = await checkoutPgClient(pool)
    return await queryOnboardingPaymentCohortData(client, period)
  }
  finally {
    try {
      if (client) releasePgClient(pool, client)
    }
    finally {
      await closeClient(c, pool)
    }
  }
}
