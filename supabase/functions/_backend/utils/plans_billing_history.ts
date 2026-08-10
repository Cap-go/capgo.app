import type { Context } from 'hono'
import type { PoolClient } from 'pg'
import { closeClient, getPgClient } from './pg.ts'

export interface RevenueMovement {
  date: string
  openingMrr: number
  newBusinessMrr: number
  expansionMrr: number
  contractionMrr: number
  churnMrr: number
  churnReason: string | null
}

export interface BillingTransition {
  timestampMs: number
  kind: 'paid' | 'canceled' | 'payment_problem' | 'recovered'
}

export interface OrganizationBillingHistory {
  orgId: string
  customerId: string | null
  trialEndsAtMs: number | null
  paidAtMs: number | null
  canceledAtMs: number | null
  currentPastDueAtMs: number | null
  churnReason: string | null
  revenueMovements: RevenueMovement[]
  transitions: BillingTransition[]
  creditGrants: Array<{ id: string, grantedAtMs: number, expiresAtMs: number, creditsTotal: number }>
  creditConsumptions: Array<{ grantId: string, appliedAtMs: number, creditsUsed: number }>
}

export type HistoricalPaidState = 'paying' | 'not_paying' | 'payment_problem' | 'unknown'

type BillingHistoryEvidence = Omit<OrganizationBillingHistory, 'revenueMovements' | 'transitions' | 'creditGrants' | 'creditConsumptions'> & {
  readonly revenueMovements: readonly RevenueMovement[]
  readonly transitions: readonly BillingTransition[]
  readonly creditGrants: ReadonlyArray<{ id: string, grantedAtMs: number, expiresAtMs: number, creditsTotal: number }>
  readonly creditConsumptions: ReadonlyArray<{ grantId: string, appliedAtMs: number, creditsUsed: number }>
}

interface BillingEvidenceAt {
  paidState: HistoricalPaidState
  voluntaryCancellationActive: boolean
  hasPaidBefore: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

export function endingMrr(movement: RevenueMovement): number {
  return Math.max(0, movement.openingMrr + movement.newBusinessMrr + movement.expansionMrr - movement.contractionMrr - movement.churnMrr)
}

export function hasCreditsAt(history: BillingHistoryEvidence, timestampMs: number): boolean {
  const consumedByGrant = new Map<string, number>()
  for (const consumption of history.creditConsumptions) {
    if (consumption.appliedAtMs <= timestampMs) {
      consumedByGrant.set(
        consumption.grantId,
        (consumedByGrant.get(consumption.grantId) ?? 0) + consumption.creditsUsed,
      )
    }
  }

  return history.creditGrants.some(grant => (
    grant.grantedAtMs <= timestampMs
    && grant.expiresAtMs >= timestampMs
    && grant.creditsTotal - (consumedByGrant.get(grant.id) ?? 0) > 0
  ))
}

function utcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10)
}

function utcDayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

function isValidRevenueDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return false
  const timestampMs = utcDayStart(date)
  return Number.isFinite(timestampMs) && utcDate(timestampMs) === date
}

function hasValidBillingEvidence(history: BillingHistoryEvidence, timestampMs: number): boolean {
  if (!Number.isFinite(timestampMs))
    return false

  const scalarTimestamps = [history.trialEndsAtMs, history.paidAtMs, history.canceledAtMs, history.currentPastDueAtMs]
  if (scalarTimestamps.some(value => value !== null && !Number.isFinite(value)))
    return false

  if (history.transitions.some(transition => !Number.isFinite(transition.timestampMs)))
    return false

  if (history.revenueMovements.some(movement => (
    !isValidRevenueDate(movement.date)
    || ![
      movement.openingMrr,
      movement.newBusinessMrr,
      movement.expansionMrr,
      movement.contractionMrr,
      movement.churnMrr,
    ].every(value => Number.isFinite(value) && value >= 0)
  ))) {
    return false
  }

  if (history.creditGrants.some(grant => (
    !Number.isFinite(grant.grantedAtMs)
    || !Number.isFinite(grant.expiresAtMs)
    || !Number.isFinite(grant.creditsTotal)
    || grant.creditsTotal < 0
    || grant.expiresAtMs < grant.grantedAtMs
  ))) {
    return false
  }

  return !history.creditConsumptions.some(consumption => (
    !Number.isFinite(consumption.appliedAtMs)
    || !Number.isFinite(consumption.creditsUsed)
    || consumption.creditsUsed <= 0
  ))
}

interface BillingEvidenceEvent extends BillingTransition {
  order: number
}

function isPaymentFailureChurnReason(reason: string | null): boolean {
  // This is the only internal payment-failure churn variant written by the Stripe event pipeline.
  return reason === 'past_due_unresolved'
}

function isPaymentFailureCancellation(history: BillingHistoryEvidence): boolean {
  if (isPaymentFailureChurnReason(history.churnReason))
    return true
  if (history.canceledAtMs === null)
    return false

  const cancellationDate = utcDate(history.canceledAtMs)
  return history.revenueMovements.some(movement => (
    movement.date === cancellationDate
    && movement.churnMrr > 0
    && isPaymentFailureChurnReason(movement.churnReason)
  ))
}

function billingEvidenceTimeline(history: BillingHistoryEvidence): BillingEvidenceEvent[] {
  const timeline: BillingEvidenceEvent[] = history.transitions
    .filter(transition => Number.isFinite(transition.timestampMs))
    .map((transition, order) => ({ ...transition, order }))
  let order = timeline.length

  if (history.paidAtMs !== null)
    timeline.push({ timestampMs: history.paidAtMs, kind: 'paid', order: order++ })
  if (history.currentPastDueAtMs !== null)
    timeline.push({ timestampMs: history.currentPastDueAtMs, kind: 'payment_problem', order: order++ })
  if (history.canceledAtMs !== null) {
    timeline.push({
      timestampMs: history.canceledAtMs,
      kind: isPaymentFailureCancellation(history) ? 'payment_problem' : 'canceled',
      order,
    })
  }

  return timeline.sort((left, right) => left.timestampMs - right.timestampMs || left.order - right.order)
}

function hasContradictoryEventAtOrBefore(timeline: BillingEvidenceEvent[], timestampMs: number): boolean {
  let latestTimestamp = Number.NEGATIVE_INFINITY
  let latestKinds = new Set<BillingTransition['kind']>()
  for (const event of timeline) {
    if (event.timestampMs > timestampMs)
      break
    if (event.timestampMs !== latestTimestamp) {
      latestTimestamp = event.timestampMs
      latestKinds = new Set()
    }
    latestKinds.add(event.kind)
  }
  return latestKinds.size > 1
}

function billingEvidenceAt(history: BillingHistoryEvidence, timestampMs: number): BillingEvidenceAt {
  if (!hasValidBillingEvidence(history, timestampMs)) {
    return {
      paidState: 'unknown',
      voluntaryCancellationActive: false,
      hasPaidBefore: false,
    }
  }

  const timeline = billingEvidenceTimeline(history)
  if (hasContradictoryEventAtOrBefore(timeline, timestampMs)) {
    return {
      paidState: 'unknown',
      voluntaryCancellationActive: false,
      hasPaidBefore: false,
    }
  }

  const visitDate = utcDate(timestampMs)
  const movement = history.revenueMovements
    .filter(candidate => candidate.date <= visitDate)
    .sort((left, right) => left.date.localeCompare(right.date))
    .at(-1)

  let entitled = movement ? endingMrr(movement) > 0 : false
  let evidenceStartMs = Number.NEGATIVE_INFINITY

  if (movement) {
    evidenceStartMs = utcDayStart(movement.date)
    if (movement.date === visitDate) {
      entitled = movement.openingMrr > 0
      const dayEndMs = evidenceStartMs + DAY_MS
      const dayEvents = timeline.filter(event => event.timestampMs >= evidenceStartMs && event.timestampMs < dayEndMs)
      const changesEntitlement = movement.openingMrr > 0 !== (endingMrr(movement) > 0)

      if (changesEntitlement) {
        let endingEntitled = movement.openingMrr > 0
        for (const event of dayEvents) {
          if (event.kind === 'paid' || event.kind === 'recovered')
            endingEntitled = true
          else if (event.kind === 'canceled' || event.kind === 'payment_problem')
            endingEntitled = false
        }
        const unresolvedMovementDay = hasContradictoryEventAtOrBefore(dayEvents, dayEndMs - 1)
          || dayEvents.length === 0
          || endingEntitled !== (endingMrr(movement) > 0)
        const laterEvidence = timeline.filter(event => event.timestampMs >= dayEndMs && event.timestampMs <= timestampMs)
        const supersededByLaterEvidence = laterEvidence.length > 0
          && !hasContradictoryEventAtOrBefore(laterEvidence, timestampMs)
        if (unresolvedMovementDay && !supersededByLaterEvidence) {
          return {
            paidState: 'unknown',
            voluntaryCancellationActive: false,
            hasPaidBefore: false,
          }
        }
      }
    }
    else {
      evidenceStartMs += DAY_MS
    }
  }

  let paymentProblemActive = false
  let voluntaryCancellationActive = false
  let hasPaidBefore = false

  for (const event of timeline) {
    if (event.timestampMs > timestampMs)
      break

    if (event.kind === 'paid') {
      hasPaidBefore = true
      paymentProblemActive = false
      voluntaryCancellationActive = false
    }
    else if (event.kind === 'recovered') {
      paymentProblemActive = false
    }
    else if (event.kind === 'payment_problem') {
      paymentProblemActive = true
    }
    else {
      paymentProblemActive = false
      voluntaryCancellationActive = true
    }

    if (event.timestampMs >= evidenceStartMs) {
      if (event.kind === 'paid' || event.kind === 'recovered')
        entitled = true
      else if (event.kind === 'canceled' || event.kind === 'payment_problem')
        entitled = false
    }
  }

  if (paymentProblemActive) {
    return {
      paidState: 'payment_problem',
      voluntaryCancellationActive,
      hasPaidBefore,
    }
  }

  return {
    paidState: entitled ? 'paying' : 'not_paying',
    voluntaryCancellationActive,
    hasPaidBefore,
  }
}

export function paidStateAt(history: BillingHistoryEvidence, timestampMs: number): HistoricalPaidState {
  return billingEvidenceAt(history, timestampMs).paidState
}

export function classifyPlansBillingAt(history: BillingHistoryEvidence, timestampMs: number) {
  const evidence = billingEvidenceAt(history, timestampMs)

  if (evidence.paidState === 'unknown')
    return 'unknown' as const
  if (evidence.paidState === 'payment_problem')
    return 'payment_problem' as const
  if (evidence.paidState === 'paying')
    return 'paying' as const
  if (history.trialEndsAtMs !== null && timestampMs < history.trialEndsAtMs)
    return 'active_trial' as const
  if (hasCreditsAt(history, timestampMs))
    return 'credits_only' as const
  if (evidence.hasPaidBefore && evidence.voluntaryCancellationActive)
    return 'canceled' as const
  if (history.trialEndsAtMs !== null && timestampMs >= history.trialEndsAtMs && !evidence.hasPaidBefore)
    return 'expired_trial' as const
  return 'unknown' as const
}

interface OrganizationRow {
  org_id: string
  customer_id: string | null
  trial_at: string | Date | null
  paid_at: string | Date | null
  canceled_at: string | Date | null
  past_due_at: string | Date | null
  churn_reason: string | null
}

interface RevenueRow {
  customer_id: string
  date_id: string
  opening_mrr: number | string
  new_business_mrr: number | string
  expansion_mrr: number | string
  contraction_mrr: number | string
  churn_mrr: number | string
  churn_reason: string | null
}

interface CreditGrantRow {
  id: string
  org_id: string
  granted_at: string | Date
  expires_at: string | Date
  credits_total: number | string
}

interface CreditConsumptionRow {
  grant_id: string
  org_id: string
  applied_at: string | Date
  credits_used: number | string
}

function timestamp(value: string | Date | null): number | null {
  return value === null ? null : new Date(value).getTime()
}

export async function loadPlansBillingHistories(
  c: Context,
  orgIds: string[],
  startDate: string,
  endDate: string,
  transitions: Map<string, BillingTransition[]>,
): Promise<Map<string, OrganizationBillingHistory>> {
  if (orgIds.length === 0)
    return new Map()

  const pool = getPgClient(c, true)
  let client: PoolClient | undefined

  try {
    client = await pool.connect()
    const organizations = await client.query<OrganizationRow>(`
      SELECT o.id::text AS org_id, o.customer_id, si.trial_at, si.paid_at,
             si.canceled_at, si.past_due_at, si.churn_reason
      FROM public.orgs o
      LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
      WHERE o.id = ANY($1::uuid[])
    `, [orgIds])

    const histories = new Map<string, OrganizationBillingHistory>()
    const orgIdByCustomer = new Map<string, string>()
    for (const row of organizations.rows) {
      histories.set(row.org_id, {
        orgId: row.org_id,
        customerId: row.customer_id,
        trialEndsAtMs: timestamp(row.trial_at),
        paidAtMs: timestamp(row.paid_at),
        canceledAtMs: timestamp(row.canceled_at),
        currentPastDueAtMs: timestamp(row.past_due_at),
        churnReason: row.churn_reason,
        revenueMovements: [],
        transitions: [...(transitions.get(row.org_id) ?? [])],
        creditGrants: [],
        creditConsumptions: [],
      })
      if (row.customer_id)
        orgIdByCustomer.set(row.customer_id, row.org_id)
    }

    const customerIds = [...orgIdByCustomer.keys()]
    if (customerIds.length > 0) {
      const revenue = await client.query<RevenueRow>(`
        WITH relevant_customers AS (
          SELECT customer_id
          FROM unnest($1::text[]) AS customer_id
        ), carry_in AS (
          SELECT latest.*
          FROM relevant_customers rc
          CROSS JOIN LATERAL (
            SELECT drm.customer_id, drm.date_id, drm.opening_mrr, drm.new_business_mrr,
                   drm.expansion_mrr, drm.contraction_mrr, drm.churn_mrr, drm.churn_reason
            FROM public.processed_stripe_events pse
            JOIN public.daily_revenue_metrics drm
              ON drm.date_id = pse.date_id
             AND drm.customer_id = pse.customer_id
            WHERE pse.customer_id = rc.customer_id
              AND pse.date_id < $2::text
            ORDER BY pse.date_id DESC
            LIMIT 1
          ) latest
        ), in_range AS (
          SELECT drm.customer_id, drm.date_id, drm.opening_mrr, drm.new_business_mrr,
                 drm.expansion_mrr, drm.contraction_mrr, drm.churn_mrr, drm.churn_reason
          FROM relevant_customers rc
          CROSS JOIN LATERAL (
            SELECT DISTINCT pse.date_id
            FROM public.processed_stripe_events pse
            WHERE pse.customer_id = rc.customer_id
              AND pse.date_id BETWEEN $2::text AND $3::text
          ) movement_dates
          JOIN public.daily_revenue_metrics drm
            ON drm.date_id = movement_dates.date_id
           AND drm.customer_id = rc.customer_id
        )
        SELECT * FROM carry_in
        UNION ALL
        SELECT * FROM in_range
        ORDER BY customer_id, date_id
      `, [customerIds, startDate, endDate])

      for (const row of revenue.rows) {
        const history = histories.get(orgIdByCustomer.get(row.customer_id) ?? '')
        history?.revenueMovements.push({
          date: row.date_id,
          openingMrr: Number(row.opening_mrr),
          newBusinessMrr: Number(row.new_business_mrr),
          expansionMrr: Number(row.expansion_mrr),
          contractionMrr: Number(row.contraction_mrr),
          churnMrr: Number(row.churn_mrr),
          churnReason: row.churn_reason,
        })
      }
    }

    const grants = await client.query<CreditGrantRow>(`
      SELECT g.id::text, g.org_id::text, g.granted_at, g.expires_at, g.credits_total
      FROM public.usage_credit_grants g
      WHERE g.org_id = ANY($1::uuid[])
        AND g.granted_at < ($3::date + INTERVAL '1 day')
        AND g.expires_at >= $2::date
      ORDER BY g.org_id, g.granted_at, g.id
    `, [orgIds, startDate, endDate])

    const grantIds: string[] = []
    for (const row of grants.rows) {
      grantIds.push(row.id)
      histories.get(row.org_id)?.creditGrants.push({
        id: row.id,
        grantedAtMs: timestamp(row.granted_at)!,
        expiresAtMs: timestamp(row.expires_at)!,
        creditsTotal: Number(row.credits_total),
      })
    }

    if (grantIds.length > 0) {
      const consumptions = await client.query<CreditConsumptionRow>(`
        SELECT c.grant_id::text, c.org_id::text, c.applied_at, c.credits_used
        FROM public.usage_credit_consumptions c
        WHERE c.grant_id = ANY($1::uuid[])
          AND c.applied_at < ($2::date + INTERVAL '1 day')
        ORDER BY c.org_id, c.applied_at, c.id
      `, [grantIds, endDate])

      for (const row of consumptions.rows) {
        histories.get(row.org_id)?.creditConsumptions.push({
          grantId: row.grant_id,
          appliedAtMs: timestamp(row.applied_at)!,
          creditsUsed: Number(row.credits_used),
        })
      }
    }

    return histories
  }
  finally {
    client?.release()
    await closeClient(c, pool)
  }
}
