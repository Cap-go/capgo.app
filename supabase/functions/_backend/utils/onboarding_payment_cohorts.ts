import type { Context } from 'hono'
import type { OnboardingCreditPayment, OnboardingPaymentCohortPeriod, OnboardingPaymentCohortReport, OnboardingSubscriptionPayment } from './onboarding_payment_cohorts_model.ts'
import { loadOnboardingPaymentCohortData } from './onboarding_payment_cohorts_data.ts'
import { aggregateOnboardingPaymentCohorts, assertOnboardingPaymentSourceComplete, ONBOARDING_PAYMENT_SOURCE_LIMIT, onboardingPaymentCohortPeriod, onboardingPaymentSourceNumber, onboardingPaymentSourceString, onboardingPaymentSourceTimestamp } from './onboarding_payment_cohorts_model.ts'
import { queryPosthogHogql } from './posthog_read.ts'

const INVOICE_SCOPE_BATCH_SIZE = 500
const INVOICE_BATCH_CONCURRENCY = 4
const INVOICE_REPORT_DEADLINE_MS = 60_000

function hogqlString(value: string): string {
  return `'${onboardingPaymentSourceString(value).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`
}

export function buildOnboardingPaymentInvoiceHogql(period: OnboardingPaymentCohortPeriod, scope: string[], kind: 'subscription' | 'credit'): string {
  const column = kind === 'subscription' ? 'customer_id' : 'payment_intent'
  const selected = kind === 'subscription' ? 'customer_id' : 'payment_intent AS payment_intent_id'
  // Exact credit intents must reveal even out-of-window invoice timestamps; hiding
  // an existing invoice would incorrectly replace its date with a grant fallback.
  const periodFilter = kind === 'subscription'
    ? `AND toDateTime(JSONExtractInt(status_transitions, 'paid_at')) >= parseDateTimeBestEffort(${hogqlString(period.start)})
      AND toDateTime(JSONExtractInt(status_transitions, 'paid_at')) < parseDateTimeBestEffort(${hogqlString(period.cutoff)})`
    : ''
  return `
    SELECT ${selected}, toUnixTimestamp(toDateTime(JSONExtractInt(status_transitions, 'paid_at'))) AS paid_at_seconds,
           count() OVER () AS total_rows
    FROM stripe_2stripe_invoice
    WHERE livemode AND paid AND amount_paid > 0
      ${kind === 'subscription' ? 'AND subscription_id IS NOT NULL AND subscription_id != \'\'' : ''}
      AND JSONExtractInt(status_transitions, 'paid_at') > 0
      ${periodFilter}
      AND ${scope.length ? `${column} IN (${scope.map(hogqlString).join(', ')})` : '1 = 0'}
    GROUP BY ${column}, paid_at_seconds
    ORDER BY ${column}, paid_at_seconds
    LIMIT ${ONBOARDING_PAYMENT_SOURCE_LIMIT}`
}

function loadInvoicePayments(c: Context, period: OnboardingPaymentCohortPeriod, scope: string[], kind: 'subscription', signal: AbortSignal): Promise<OnboardingSubscriptionPayment[]>
function loadInvoicePayments(c: Context, period: OnboardingPaymentCohortPeriod, scope: string[], kind: 'credit', signal: AbortSignal): Promise<OnboardingCreditPayment[]>
async function loadInvoicePayments(c: Context, period: OnboardingPaymentCohortPeriod, scope: string[], kind: 'subscription' | 'credit', signal: AbortSignal) {
  const records: Record<string, unknown>[] = []
  let nextOffset = 0
  // Even an empty cohort verifies the authoritative source instead of masking an outage.
  const worker = async () => {
    while (nextOffset < Math.max(scope.length, 1)) {
      signal.throwIfAborted()
      const offset = nextOffset
      nextOffset += INVOICE_SCOPE_BATCH_SIZE
      const result = await queryPosthogHogql(c, buildOnboardingPaymentInvoiceHogql(period, scope.slice(offset, offset + INVOICE_SCOPE_BATCH_SIZE), kind), {
        requiredColumns: [kind === 'subscription' ? 'customer_id' : 'payment_intent_id', 'paid_at_seconds', 'total_rows'],
        signal,
      })
      if (!result.configured || !result.connected || result.failureReason)
        throw new Error('Payment cohort invoice source unavailable')
      assertOnboardingPaymentSourceComplete(result.rows, 'invoice source')
      records.push(...result.rows)
      if (records.length > ONBOARDING_PAYMENT_SOURCE_LIMIT)
        throw new Error('Incomplete invoice source: combined source limit exceeded')
    }
  }
  await Promise.all(Array.from({ length: Math.min(INVOICE_BATCH_CONCURRENCY, Math.max(1, Math.ceil(scope.length / INVOICE_SCOPE_BATCH_SIZE))) }, worker))
  return records.map((row) => {
    const seconds = onboardingPaymentSourceNumber(row.paid_at_seconds)
    if (!Number.isSafeInteger(seconds) || seconds <= 0)
      throw new Error('Malformed invoice source paid timestamp')
    const paid_at = onboardingPaymentSourceTimestamp(new Date(seconds * 1000))
    if (kind === 'subscription')
      return { customer_id: onboardingPaymentSourceString(row.customer_id), paid_at }
    return { payment_intent_id: onboardingPaymentSourceString(row.payment_intent_id), paid_at }
  })
}

async function invoiceFreshness(c: Context, signal: AbortSignal): Promise<{ invoice_last_synced_at: string | null, invoice_sync_type: string | null }> {
  const unavailable = { invoice_last_synced_at: null, invoice_sync_type: null }
  try {
    const result = await queryPosthogHogql(c, `
      SELECT status, last_synced_at, sync_type FROM system.source_schemas
      WHERE table_id IN (SELECT id FROM system.data_warehouse_tables WHERE name = 'stripe_2stripe_invoice' AND NOT deleted)
        AND NOT deleted AND should_sync
      LIMIT 5`, { requiredColumns: ['status', 'last_synced_at', 'sync_type'], signal })
    if (!result.configured || !result.connected || result.failureReason || result.rows.length !== 1)
      return unavailable
    const row = result.rows[0]
    return {
      invoice_last_synced_at: row.last_synced_at === null ? null : onboardingPaymentSourceTimestamp(row.last_synced_at),
      invoice_sync_type: row.sync_type === null ? null : onboardingPaymentSourceString(row.sync_type),
    }
  }
  catch {
    // Source freshness is optional; financial lookup failures above are never swallowed.
    return unavailable
  }
}

export async function getAdminOnboardingPaymentCohorts(c: Context, now = new Date()): Promise<OnboardingPaymentCohortReport> {
  const period = onboardingPaymentCohortPeriod(now)
  const data = await loadOnboardingPaymentCohortData(c, period)
  const customers = [...new Set(data.orgs.flatMap(org => org.customer_id === null ? [] : [org.customer_id]))]
  const intents = [...new Set(data.grants.flatMap(grant => grant.payment_intent_id === null ? [] : [grant.payment_intent_id]))]
  // Four warehouse reads in flight, twenty seconds each, with a shared wall-clock cap.
  const controller = new AbortController()
  const signal = AbortSignal.any([AbortSignal.timeout(INVOICE_REPORT_DEADLINE_MS), controller.signal])
  try {
    const subscriptionPayments = await loadInvoicePayments(c, period, customers, 'subscription', signal)
    const creditPayments = intents.length ? await loadInvoicePayments(c, period, intents, 'credit', signal) : []
    return aggregateOnboardingPaymentCohorts({
      ...period,
      ...data,
      subscription_payments: subscriptionPayments,
      credit_payments: creditPayments,
      ...await invoiceFreshness(c, signal),
    })
  }
  finally {
    // Cancel in-flight siblings immediately if one batch fails or the caller finishes.
    controller.abort()
  }
}
