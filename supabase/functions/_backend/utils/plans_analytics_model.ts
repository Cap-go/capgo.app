export const LEGACY_BURST_SECONDS = 30
export const CHECKOUT_ATTRIBUTION_MS = 24 * 60 * 60 * 1000

export type PlansBillingCategory
  = | 'paying'
    | 'active_trial'
    | 'expired_trial'
    | 'canceled'
    | 'payment_problem'
    | 'credits_only'
    | 'unknown'

export interface PlansBehaviorEvent {
  event: 'User visit' | 'Checkout Started'
  timestampMs: number
  orgId: string
  actorId: string
  sessionId: string
  page: string
  path: string
}

export interface LogicalPlansOpening extends PlansBehaviorEvent {
  source: 'exact' | 'legacy'
}

export interface AttributedCheckout {
  checkoutTimestampMs: number
  orgId: string
  opening: LogicalPlansOpening
  attributedDate: string
}

export interface DailyBillingPoint {
  date: string
  paying: number
  activeTrial: number
  expiredTrial: number
  canceled: number
  paymentProblem: number
  creditsOnly: number
  unknown: number
  total: number
}

export interface DailyCheckoutIntentPoint {
  date: string
  startedCheckout: number
  didNotStart: number
}

export interface PlansChartData {
  traffic: {
    dates: string[]
    uniqueVisitorOrganizations: number[]
    totalOpens: number[]
  }
  visitorBreakdown: DailyBillingPoint[]
  checkoutIntent: DailyCheckoutIntentPoint[]
  checkoutVisitorBreakdown: DailyBillingPoint[]
}

const LEGACY_PLANS_PATH = '/settings/organization/plans'
const DAY_MS = 24 * 60 * 60 * 1000

function utcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10)
}

function normalizePath(value: string): string | null {
  try {
    const pathname = new URL(value, 'https://capgo.app').pathname
    return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  }
  catch {
    return null
  }
}

function sortedWithInputOrder<T extends { timestampMs: number }>(items: T[]): T[] {
  return items
    .filter(item => Number.isFinite(item.timestampMs))
    .map((item, index) => ({ index, item }))
    .sort((left, right) => left.item.timestampMs - right.item.timestampMs || left.index - right.index)
    .map(({ item }) => item)
}

export function buildLogicalPlansOpenings(
  events: PlansBehaviorEvent[],
  startMs: number,
  endMs: number,
  burstSeconds = LEGACY_BURST_SECONDS,
): LogicalPlansOpening[] {
  const previousLegacyTimestamp = new Map<string, number>()
  const openings: LogicalPlansOpening[] = []
  const burstMs = burstSeconds * 1000

  for (const behaviorEvent of sortedWithInputOrder(events)) {
    if (behaviorEvent.event !== 'User visit' || behaviorEvent.timestampMs >= endMs)
      continue

    if (behaviorEvent.page === 'plans') {
      if (behaviorEvent.timestampMs >= startMs)
        openings.push({ ...behaviorEvent, source: 'exact' })
      continue
    }

    if (normalizePath(behaviorEvent.path) !== LEGACY_PLANS_PATH)
      continue

    const identity = behaviorEvent.sessionId || behaviorEvent.actorId
    const identityKey = `${behaviorEvent.orgId}\u0000${identity}`
    const previousTimestamp = previousLegacyTimestamp.get(identityKey)
    previousLegacyTimestamp.set(identityKey, behaviorEvent.timestampMs)

    if (
      behaviorEvent.timestampMs >= startMs
      && (previousTimestamp === undefined || behaviorEvent.timestampMs - previousTimestamp > burstMs)
    ) {
      openings.push({ ...behaviorEvent, source: 'legacy' })
    }
  }

  return openings
}

export function attributeCheckoutStarts(
  openings: LogicalPlansOpening[],
  checkoutEvents: PlansBehaviorEvent[],
): AttributedCheckout[] {
  const openingsByOrganization = new Map<string, LogicalPlansOpening[]>()
  for (const opening of sortedWithInputOrder(openings)) {
    const organizationOpenings = openingsByOrganization.get(opening.orgId) ?? []
    organizationOpenings.push(opening)
    openingsByOrganization.set(opening.orgId, organizationOpenings)
  }

  const attributed: AttributedCheckout[] = []
  for (const checkout of sortedWithInputOrder(checkoutEvents)) {
    if (checkout.event !== 'Checkout Started')
      continue

    const organizationOpenings = openingsByOrganization.get(checkout.orgId) ?? []
    let lower = 0
    let upper = organizationOpenings.length
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (organizationOpenings[middle].timestampMs <= checkout.timestampMs)
        lower = middle + 1
      else
        upper = middle
    }
    const matchedOpening = organizationOpenings[lower - 1]

    if (!matchedOpening || checkout.timestampMs - matchedOpening.timestampMs > CHECKOUT_ATTRIBUTION_MS)
      continue

    attributed.push({
      checkoutTimestampMs: checkout.timestampMs,
      orgId: checkout.orgId,
      opening: matchedOpening,
      attributedDate: utcDate(matchedOpening.timestampMs),
    })
  }

  return attributed
}

function createDailyBillingPoint(date: string): DailyBillingPoint {
  return {
    date,
    paying: 0,
    activeTrial: 0,
    expiredTrial: 0,
    canceled: 0,
    paymentProblem: 0,
    creditsOnly: 0,
    unknown: 0,
    total: 0,
  }
}

function incrementCategory(point: DailyBillingPoint, category: PlansBillingCategory): void {
  type BillingCountKey = Exclude<keyof DailyBillingPoint, 'date' | 'total'>
  const categoryKeys: Record<PlansBillingCategory, BillingCountKey> = {
    paying: 'paying',
    active_trial: 'activeTrial',
    expired_trial: 'expiredTrial',
    canceled: 'canceled',
    payment_problem: 'paymentProblem',
    credits_only: 'creditsOnly',
    unknown: 'unknown',
  }
  const key = categoryKeys[category]
  point[key] += 1
  point.total += 1
}

function utcDaysIntersecting(startMs: number, endMs: number): string[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    return []

  const start = new Date(startMs)
  let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  const dates: string[] = []
  while (cursor < endMs) {
    dates.push(utcDate(cursor))
    cursor += DAY_MS
  }
  return dates
}

export function buildPlansChartData(input: {
  openings: LogicalPlansOpening[]
  attributedCheckouts: AttributedCheckout[]
  startMs: number
  endMs: number
  classifyAt: (orgId: string, timestampMs: number) => PlansBillingCategory
}): PlansChartData {
  const dates = utcDaysIntersecting(input.startMs, input.endMs)
  const dateIndexes = new Map(dates.map((date, index) => [date, index]))
  const uniqueVisitorOrganizations = dates.map(() => 0)
  const totalOpens = dates.map(() => 0)
  const visitorBreakdown = dates.map(createDailyBillingPoint)
  const checkoutIntent = dates.map(date => ({ date, startedCheckout: 0, didNotStart: 0 }))
  const checkoutVisitorBreakdown = dates.map(createDailyBillingPoint)
  const firstDailyOpening = new Map<string, LogicalPlansOpening>()
  const seenOrganizations = new Set<string>()

  for (const opening of sortedWithInputOrder(input.openings)) {
    if (opening.timestampMs < input.startMs || opening.timestampMs >= input.endMs)
      continue

    const date = utcDate(opening.timestampMs)
    const dateIndex = dateIndexes.get(date)
    if (dateIndex === undefined)
      continue

    totalOpens[dateIndex] += 1
    if (!seenOrganizations.has(opening.orgId)) {
      seenOrganizations.add(opening.orgId)
      uniqueVisitorOrganizations[dateIndex] += 1
    }

    const visitorKey = `${date}\u0000${opening.orgId}`
    if (!firstDailyOpening.has(visitorKey))
      firstDailyOpening.set(visitorKey, opening)
  }

  for (const opening of firstDailyOpening.values()) {
    const dateIndex = dateIndexes.get(utcDate(opening.timestampMs))
    if (dateIndex !== undefined)
      incrementCategory(visitorBreakdown[dateIndex], input.classifyAt(opening.orgId, opening.timestampMs))
  }

  const earliestCheckoutByVisitor = new Map<string, AttributedCheckout>()
  for (const checkout of input.attributedCheckouts) {
    if (!Number.isFinite(checkout.checkoutTimestampMs) || !Number.isFinite(checkout.opening.timestampMs))
      continue

    const visitorKey = `${checkout.attributedDate}\u0000${checkout.orgId}`
    if (!firstDailyOpening.has(visitorKey))
      continue

    const previous = earliestCheckoutByVisitor.get(visitorKey)
    if (!previous || checkout.checkoutTimestampMs < previous.checkoutTimestampMs)
      earliestCheckoutByVisitor.set(visitorKey, checkout)
  }

  for (const [visitorKey, opening] of firstDailyOpening) {
    const dateIndex = dateIndexes.get(utcDate(opening.timestampMs))
    if (dateIndex === undefined)
      continue
    if (earliestCheckoutByVisitor.has(visitorKey))
      checkoutIntent[dateIndex].startedCheckout += 1
    else
      checkoutIntent[dateIndex].didNotStart += 1
  }

  for (const checkout of earliestCheckoutByVisitor.values()) {
    const dateIndex = dateIndexes.get(checkout.attributedDate)
    if (dateIndex !== undefined) {
      incrementCategory(
        checkoutVisitorBreakdown[dateIndex],
        input.classifyAt(checkout.orgId, checkout.opening.timestampMs),
      )
    }
  }

  return {
    traffic: { dates, uniqueVisitorOrganizations, totalOpens },
    visitorBreakdown,
    checkoutIntent,
    checkoutVisitorBreakdown,
  }
}
