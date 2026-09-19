export const ONBOARDING_PAYMENT_SOURCE_LIMIT = 50_000
const DAY_MS = 86_400_000

export interface OnboardingPaymentCohortPeriod {
  start: string
  cutoff: string
}

export interface OnboardingPaymentCohortUser {
  id: string
  signup_at: string
  has_public_row: boolean
  created_via_invite: boolean
}

export interface OnboardingPaymentCohortOrg {
  id: string
  created_by: string
  customer_id: string | null
}

export interface OnboardingPaymentCohortGrant {
  id: string
  org_id: string
  granted_at: string
  credits_total: number
  source: string
  payment_intent_id: string | null
}

export interface OnboardingPaymentCohortData {
  users: OnboardingPaymentCohortUser[]
  orgs: OnboardingPaymentCohortOrg[]
  grants: OnboardingPaymentCohortGrant[]
}

export interface OnboardingSubscriptionPayment {
  customer_id: string
  paid_at: string
}

export interface OnboardingCreditPayment {
  payment_intent_id: string
  paid_at: string
}

export interface OnboardingPaymentConversion {
  paid: number
  eligible: number
  conversion_percent: number | null
}

export interface OnboardingPaymentCohortRow {
  month: string
  signups: number
  excluded_no_public_row: number
  excluded_invite: number
  days_3: OnboardingPaymentConversion
  days_7: OnboardingPaymentConversion
  days_14: OnboardingPaymentConversion
  ever: OnboardingPaymentConversion
}

export interface OnboardingPaymentCohortReport extends OnboardingPaymentCohortPeriod {
  rows: OnboardingPaymentCohortRow[]
  credit_timestamp_fallbacks: number
  invoice_last_synced_at: string | null
  invoice_sync_type: string | null
}

interface OnboardingPaymentCohortInput extends OnboardingPaymentCohortPeriod, OnboardingPaymentCohortData {
  subscription_payments: OnboardingSubscriptionPayment[]
  credit_payments: OnboardingCreditPayment[]
  invoice_last_synced_at?: string | null
  invoice_sync_type?: string | null
}

export function onboardingPaymentSourceString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || [...value].some(char => char.charCodeAt(0) < 32))
    throw new Error('Malformed payment cohort source identifier')
  return value
}

export function onboardingPaymentSourceTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error('Malformed payment cohort source timestamp')
    return value.toISOString()
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value))
    throw new Error('Malformed payment cohort source timestamp')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error('Malformed payment cohort source timestamp')
  return parsed.toISOString()
}

export function onboardingPaymentSourceNumber(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)))
    throw new Error('Malformed payment cohort source number')
  const result = Number(value)
  if (!Number.isFinite(result) || result < 0)
    throw new Error('Malformed payment cohort source number')
  return result
}

export function assertOnboardingPaymentSourceComplete(rows: Record<string, unknown>[], source: string) {
  if (rows.length > ONBOARDING_PAYMENT_SOURCE_LIMIT)
    throw new Error(`Incomplete ${source}: source limit exceeded`)
  for (const row of rows) {
    const total = onboardingPaymentSourceNumber(row.total_rows)
    if (!Number.isSafeInteger(total) || total !== rows.length)
      throw new Error(`Incomplete ${source}: result count mismatch`)
  }
}

export function onboardingPaymentCohortPeriod(now = new Date()): OnboardingPaymentCohortPeriod {
  if (!Number.isFinite(now.getTime()))
    throw new Error('Malformed payment cohort cutoff timestamp')
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString(),
    cutoff: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString(),
  }
}

function emptyConversion(): OnboardingPaymentConversion {
  return { paid: 0, eligible: 0, conversion_percent: null }
}

function uniqueRecords<T extends { id: string }>(records: T[]): Map<string, T> {
  const result = new Map<string, T>()
  for (const record of records) {
    onboardingPaymentSourceString(record.id)
    const existing = result.get(record.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(record))
      throw new Error('Conflicting payment cohort source records')
    result.set(record.id, record)
  }
  return result
}

export function aggregateOnboardingPaymentCohorts(input: OnboardingPaymentCohortInput): OnboardingPaymentCohortReport {
  const cutoff = new Date(onboardingPaymentSourceTimestamp(input.cutoff))
  const start = Date.parse(onboardingPaymentSourceTimestamp(input.start))
  const expected = onboardingPaymentCohortPeriod(cutoff)
  if (expected.start !== input.start || expected.cutoff !== input.cutoff)
    throw new Error('Invalid payment cohort reporting period')

  const rows: OnboardingPaymentCohortRow[] = Array.from({ length: 4 }, (_, index) => ({
    month: new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() - index, 1)).toISOString().slice(0, 10),
    signups: 0,
    excluded_no_public_row: 0,
    excluded_invite: 0,
    days_3: emptyConversion(),
    days_7: emptyConversion(),
    days_14: emptyConversion(),
    ever: emptyConversion(),
  }))
  const byMonth = new Map(rows.map(row => [row.month.slice(0, 7), row]))
  const users = new Map<string, { signup: number, row: OnboardingPaymentCohortRow, firstPaid: number | null }>()
  for (const user of uniqueRecords(input.users).values()) {
    const signup = Date.parse(onboardingPaymentSourceTimestamp(user.signup_at))
    if (typeof user.has_public_row !== 'boolean' || typeof user.created_via_invite !== 'boolean')
      throw new Error('Malformed payment cohort source exclusion flag')
    if (signup < start || signup >= cutoff.getTime())
      continue
    const row = byMonth.get(new Date(signup).toISOString().slice(0, 7))!
    if (!user.has_public_row) {
      row.excluded_no_public_row++
    }
    else if (user.created_via_invite) {
      row.excluded_invite++
    }
    else {
      row.signups++
      users.set(user.id, { signup, row, firstPaid: null })
    }
  }

  const orgs = uniqueRecords(input.orgs)
  const customerCreators = new Map<string, Set<string>>()
  for (const organization of orgs.values()) {
    onboardingPaymentSourceString(organization.created_by)
    if (organization.customer_id !== null) {
      onboardingPaymentSourceString(organization.customer_id)
      if (users.has(organization.created_by)) {
        const creators = customerCreators.get(organization.customer_id) ?? new Set<string>()
        creators.add(organization.created_by)
        customerCreators.set(organization.customer_id, creators)
      }
    }
  }
  const addPayment = (creator: string, paid: number) => {
    const user = users.get(creator)
    if (user && paid >= user.signup && paid < cutoff.getTime() && (user.firstPaid === null || paid < user.firstPaid))
      user.firstPaid = paid
  }
  // Keep timestamp candidates until the per-user signup threshold is applied.
  for (const payment of input.subscription_payments) {
    onboardingPaymentSourceString(payment.customer_id)
    const paid = Date.parse(onboardingPaymentSourceTimestamp(payment.paid_at))
    for (const creator of customerCreators.get(payment.customer_id) ?? [])
      addPayment(creator, paid)
  }
  const creditPaid = new Map<string, number[]>()
  for (const payment of input.credit_payments) {
    onboardingPaymentSourceString(payment.payment_intent_id)
    const paid = Date.parse(onboardingPaymentSourceTimestamp(payment.paid_at))
    const candidates = creditPaid.get(payment.payment_intent_id) ?? []
    candidates.push(paid)
    creditPaid.set(payment.payment_intent_id, candidates)
  }
  let fallbacks = 0
  for (const grant of uniqueRecords(input.grants).values()) {
    onboardingPaymentSourceString(grant.org_id)
    const grantedAt = Date.parse(onboardingPaymentSourceTimestamp(grant.granted_at))
    const credits = onboardingPaymentSourceNumber(grant.credits_total)
    if (grant.payment_intent_id !== null)
      onboardingPaymentSourceString(grant.payment_intent_id)
    const organization = orgs.get(grant.org_id)
    if (grant.source !== 'stripe_top_up' || credits <= 0 || !organization || !users.has(organization.created_by))
      continue
    // Stripe-only grants are persisted only after successful payment confirmation.
    const user = users.get(organization.created_by)!
    const candidates = grant.payment_intent_id === null ? undefined : creditPaid.get(grant.payment_intent_id)
    if (candidates) {
      for (const paid of candidates)
        addPayment(organization.created_by, paid)
    }
    else {
      if (grantedAt >= user.signup && grantedAt < cutoff.getTime())
        fallbacks++
      addPayment(organization.created_by, grantedAt)
    }
  }

  for (const { row, signup, firstPaid } of users.values()) {
    row.ever.eligible++
    if (firstPaid !== null)
      row.ever.paid++
    for (const days of [3, 7, 14] as const) {
      const endpoint = signup + days * DAY_MS
      if (endpoint <= cutoff.getTime()) {
        const cell = row[`days_${days}`]
        cell.eligible++
        if (firstPaid !== null && firstPaid < endpoint)
          cell.paid++
      }
    }
  }
  for (const row of rows) {
    for (const cell of [row.days_3, row.days_7, row.days_14, row.ever])
      cell.conversion_percent = cell.eligible === 0 ? null : cell.paid / cell.eligible * 100
  }
  return {
    ...expected,
    rows,
    credit_timestamp_fallbacks: fallbacks,
    invoice_last_synced_at: input.invoice_last_synced_at ?? null,
    invoice_sync_type: input.invoice_sync_type ?? null,
  }
}
