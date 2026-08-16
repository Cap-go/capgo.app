import type { Database, Json } from './supabase.types.ts'
import type { PostHogGroups } from './posthog.ts'

export const CREDIT_USAGE_POSTHOG_EVENT = 'Credit Usage Ledger Entry'

export type CreditUsagePosthogSource = 'backend' | 'backfill'
export type UsageCreditTransactionRow = Database['public']['Tables']['usage_credit_transactions']['Row']
export type UsageOverageEventRow = Database['public']['Tables']['usage_overage_events']['Row']

export interface CreditUsagePosthogEventInput {
  channel: string
  description: string
  distinctId: string
  event: string
  groups: PostHogGroups
  tags: Record<string, string | number | boolean | null>
  timestamp: string
}

function jsonObject(value: Json | null | undefined): Record<string, Json | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {}

  return value
}

function jsonString(value: Json | undefined) {
  return typeof value === 'string' && value.trim() ? value : null
}

function jsonNumber(value: Json | undefined) {
  if (value === null || value === undefined || value === '')
    return null

  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function nullableNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined)
    return null

  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function compactTags(tags: Record<string, string | number | boolean | null | undefined>) {
  const output: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined)
      output[key] = value
  }
  return output
}

export function getCreditUsageSourceRefOverageEventId(sourceRef: Json | null | undefined) {
  return jsonString(jsonObject(sourceRef).overage_event_id)
}

export function buildCreditUsagePosthogEventInput(
  transaction: UsageCreditTransactionRow,
  overageEvent: UsageOverageEventRow | null,
  captureSource: CreditUsagePosthogSource,
): CreditUsagePosthogEventInput {
  const sourceRef = jsonObject(transaction.source_ref)
  const details = jsonObject(overageEvent?.details)
  const amount = nullableNumber(transaction.amount) ?? 0
  const balanceAfter = nullableNumber(transaction.balance_after)
  const overageAmount = nullableNumber(overageEvent?.overage_amount)
  const usage = jsonNumber(details.usage)
  const limit = jsonNumber(details.limit)
  const metric = overageEvent?.metric ?? jsonString(sourceRef.metric)
  const overageEventId = overageEvent?.id ?? getCreditUsageSourceRefOverageEventId(transaction.source_ref)
  const creditUsageKind = amount < 0 ? 'debit' : amount > 0 ? 'credit' : 'zero'

  return {
    channel: 'usage',
    description: transaction.description ?? `Usage credit ${transaction.transaction_type}`,
    distinctId: transaction.org_id,
    event: CREDIT_USAGE_POSTHOG_EVENT,
    groups: { organization: transaction.org_id },
    tags: compactTags({
      $insert_id: `usage_credit_transaction:${transaction.id}`,
      balance_after: balanceAfter,
      billing_cycle_end: overageEvent?.billing_cycle_end ?? null,
      billing_cycle_start: overageEvent?.billing_cycle_start ?? null,
      capture_source: captureSource,
      credit_usage_kind: creditUsageKind,
      credits_abs: Math.abs(amount),
      credits_delta: amount,
      credits_granted: Math.max(0, amount),
      credits_spent: Math.max(0, -amount),
      grant_id: transaction.grant_id,
      is_build_time_credit_usage: amount < 0 && metric === 'build_time',
      is_credit_debit: amount < 0,
      limit,
      metric,
      occurred_at: transaction.occurred_at,
      org_id: transaction.org_id,
      overage_amount: overageAmount,
      overage_event_id: overageEventId,
      source_record: 'usage_credit_transactions',
      source_record_id: String(transaction.id),
      source_ref_payment_intent_id: jsonString(sourceRef.paymentIntentId),
      source_ref_session_id: jsonString(sourceRef.sessionId),
      transaction_id: transaction.id,
      transaction_type: transaction.transaction_type,
      usage,
    }),
    timestamp: transaction.occurred_at ?? new Date().toISOString(),
  }
}
