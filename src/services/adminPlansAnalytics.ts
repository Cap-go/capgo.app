export type PlansAnalyticsFailureReason = 'unconfigured' | 'timeout' | 'unavailable' | 'too_large'

export interface PlansAnalyticsTraffic {
  dates: string[]
  uniqueVisitorOrganizations: number[]
  totalOpens: number[]
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

export interface PlansAnalyticsDataQuality {
  exactTrackingStartedAt: string | null
  exactLogicalOpens: number
  excludedMissingOrganization: number
  unmatchedCheckoutStarts: number
  unknownBillingOrganizations: number
  posthogConfigured: boolean
  posthogConnected: boolean
  posthogFailureReason: PlansAnalyticsFailureReason | null
}

export interface PlansAnalyticsResponse {
  traffic: PlansAnalyticsTraffic
  visitorBreakdown: DailyBillingPoint[]
  checkoutIntent: DailyCheckoutIntentPoint[]
  checkoutVisitorBreakdown: DailyBillingPoint[]
  dataQuality: PlansAnalyticsDataQuality
}

export type Translate = (key: string) => string

export interface PlansAnalyticsPresentationState {
  unavailableMessage: string | null
  hasTraffic: boolean
  hasVisitors: boolean
  hasCheckoutIntent: boolean
  hasCheckoutVisitors: boolean
  showPartialBillingWarning: boolean
}

export interface ChartDataPoint {
  date: string
  value: number
}

export interface ChartSeries {
  label: string
  data: ChartDataPoint[]
  color: string
}

export interface PlansAnalyticsSeries {
  traffic: ChartSeries[]
  visitors: ChartSeries[]
  checkoutIntent: ChartSeries[]
  checkoutVisitors: ChartSeries[]
}

export function buildPlansAnalyticsPresentationState(
  data: PlansAnalyticsResponse | null,
  requestError: string | null,
  translate: Translate,
): PlansAnalyticsPresentationState {
  const failureMessageKeys: Record<PlansAnalyticsFailureReason, string> = {
    unconfigured: 'plans-analytics-posthog-unconfigured',
    timeout: 'plans-analytics-posthog-timeout',
    too_large: 'plans-analytics-range-too-large',
    unavailable: 'plans-analytics-unavailable',
  }
  const failureReason = data?.dataQuality.posthogFailureReason

  return {
    unavailableMessage: requestError ?? (failureReason ? translate(failureMessageKeys[failureReason]) : null),
    hasTraffic: Boolean(data?.dataQuality.posthogConnected && data.traffic.totalOpens.some(value => value > 0)),
    hasVisitors: Boolean(data?.dataQuality.posthogConnected && data.visitorBreakdown.some(row => row.total > 0)),
    hasCheckoutIntent: Boolean(data?.dataQuality.posthogConnected && data.checkoutIntent.some(row => row.startedCheckout > 0 || row.didNotStart > 0)),
    hasCheckoutVisitors: Boolean(data?.dataQuality.posthogConnected && data.checkoutVisitorBreakdown.some(row => row.total > 0)),
    showPartialBillingWarning: Boolean(data && data.dataQuality.unknownBillingOrganizations > 0),
  }
}

export function createLatestRequestCoordinator() {
  let latestRequestId = 0
  const pendingRequestIds = new Set<number>()

  return {
    begin() {
      latestRequestId += 1
      pendingRequestIds.add(latestRequestId)
      return latestRequestId
    },
    isLatest(requestId: number) {
      return requestId === latestRequestId
    },
    finish(requestId: number) {
      pendingRequestIds.delete(requestId)
    },
    get pendingCount() {
      return pendingRequestIds.size
    },
  }
}

function invalidResponse(path: string): never {
  throw new TypeError(`Invalid Plans analytics response at ${path}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value))
    return invalidResponse(path)
  return value
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    return invalidResponse(path)
  return value
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0)
    return invalidResponse(path)
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean')
    return invalidResponse(path)
  return value
}

function utcDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return invalidResponse(path)
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value)
    return invalidResponse(path)
  return value
}

function nullableTimestamp(value: unknown, path: string): string | null {
  if (value === null)
    return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    return invalidResponse(path)
  return value
}

function nullableFailureReason(value: unknown, path: string): PlansAnalyticsFailureReason | null {
  if (value === null || value === 'unconfigured' || value === 'timeout' || value === 'unavailable' || value === 'too_large')
    return value
  return invalidResponse(path)
}

function counts(value: unknown, path: string): number[] {
  return array(value, path).map((item, index) => count(item, `${path}[${index}]`))
}

function dates(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => utcDate(item, `${path}[${index}]`))
}

function dailyBillingPoint(value: unknown, path: string): DailyBillingPoint {
  const row = record(value, path)
  return {
    date: utcDate(row.date, `${path}.date`),
    paying: count(row.paying, `${path}.paying`),
    activeTrial: count(row.activeTrial, `${path}.activeTrial`),
    expiredTrial: count(row.expiredTrial, `${path}.expiredTrial`),
    canceled: count(row.canceled, `${path}.canceled`),
    paymentProblem: count(row.paymentProblem, `${path}.paymentProblem`),
    creditsOnly: count(row.creditsOnly, `${path}.creditsOnly`),
    unknown: count(row.unknown, `${path}.unknown`),
    total: count(row.total, `${path}.total`),
  }
}

function dailyCheckoutIntentPoint(value: unknown, path: string): DailyCheckoutIntentPoint {
  const row = record(value, path)
  return {
    date: utcDate(row.date, `${path}.date`),
    startedCheckout: count(row.startedCheckout, `${path}.startedCheckout`),
    didNotStart: count(row.didNotStart, `${path}.didNotStart`),
  }
}

export function parsePlansAnalyticsResponse(value: unknown): PlansAnalyticsResponse {
  const response = record(value, 'response')
  const trafficValue = record(response.traffic, 'response.traffic')
  const traffic: PlansAnalyticsTraffic = {
    dates: dates(trafficValue.dates, 'response.traffic.dates'),
    uniqueVisitorOrganizations: counts(trafficValue.uniqueVisitorOrganizations, 'response.traffic.uniqueVisitorOrganizations'),
    totalOpens: counts(trafficValue.totalOpens, 'response.traffic.totalOpens'),
  }
  if (traffic.uniqueVisitorOrganizations.length !== traffic.dates.length || traffic.totalOpens.length !== traffic.dates.length)
    return invalidResponse('response.traffic')

  const qualityValue = record(response.dataQuality, 'response.dataQuality')
  return {
    traffic,
    visitorBreakdown: array(response.visitorBreakdown, 'response.visitorBreakdown')
      .map((row, index) => dailyBillingPoint(row, `response.visitorBreakdown[${index}]`)),
    checkoutIntent: array(response.checkoutIntent, 'response.checkoutIntent')
      .map((row, index) => dailyCheckoutIntentPoint(row, `response.checkoutIntent[${index}]`)),
    checkoutVisitorBreakdown: array(response.checkoutVisitorBreakdown, 'response.checkoutVisitorBreakdown')
      .map((row, index) => dailyBillingPoint(row, `response.checkoutVisitorBreakdown[${index}]`)),
    dataQuality: {
      exactTrackingStartedAt: nullableTimestamp(qualityValue.exactTrackingStartedAt, 'response.dataQuality.exactTrackingStartedAt'),
      exactLogicalOpens: count(qualityValue.exactLogicalOpens, 'response.dataQuality.exactLogicalOpens'),
      excludedMissingOrganization: count(qualityValue.excludedMissingOrganization, 'response.dataQuality.excludedMissingOrganization'),
      unmatchedCheckoutStarts: count(qualityValue.unmatchedCheckoutStarts, 'response.dataQuality.unmatchedCheckoutStarts'),
      unknownBillingOrganizations: count(qualityValue.unknownBillingOrganizations, 'response.dataQuality.unknownBillingOrganizations'),
      posthogConfigured: boolean(qualityValue.posthogConfigured, 'response.dataQuality.posthogConfigured'),
      posthogConnected: boolean(qualityValue.posthogConnected, 'response.dataQuality.posthogConnected'),
      posthogFailureReason: nullableFailureReason(qualityValue.posthogFailureReason, 'response.dataQuality.posthogFailureReason'),
    },
  }
}

export function buildPlansAnalyticsSeries(data: PlansAnalyticsResponse, t: Translate): PlansAnalyticsSeries {
  const point = (dates: string[], values: number[]): ChartDataPoint[] => dates.map((date, index) => ({
    date,
    value: values[index] ?? 0,
  }))
  const billing = (rows: DailyBillingPoint[]): ChartSeries[] => [
    { label: t('plans-category-paying'), color: '#2563eb', data: rows.map(row => ({ date: row.date, value: row.paying })) },
    { label: t('plans-category-active-trial'), color: '#10b981', data: rows.map(row => ({ date: row.date, value: row.activeTrial })) },
    { label: t('plans-category-expired-trial'), color: '#f59e0b', data: rows.map(row => ({ date: row.date, value: row.expiredTrial })) },
    { label: t('plans-category-canceled'), color: '#64748b', data: rows.map(row => ({ date: row.date, value: row.canceled })) },
    { label: t('plans-category-payment-problem'), color: '#ef4444', data: rows.map(row => ({ date: row.date, value: row.paymentProblem })) },
    { label: t('plans-category-credits-only'), color: '#8b5cf6', data: rows.map(row => ({ date: row.date, value: row.creditsOnly })) },
    { label: t('plans-category-unknown'), color: '#94a3b8', data: rows.map(row => ({ date: row.date, value: row.unknown })) },
  ]

  return {
    traffic: [
      { label: t('plans-analytics-unique-visitor-orgs'), color: '#2563eb', data: point(data.traffic.dates, data.traffic.uniqueVisitorOrganizations) },
      { label: t('plans-analytics-total-opens'), color: '#8b5cf6', data: point(data.traffic.dates, data.traffic.totalOpens) },
    ],
    visitors: billing(data.visitorBreakdown),
    checkoutIntent: [
      { label: t('plans-analytics-started-checkout'), color: '#10b981', data: data.checkoutIntent.map(row => ({ date: row.date, value: row.startedCheckout })) },
      { label: t('plans-analytics-did-not-start'), color: '#94a3b8', data: data.checkoutIntent.map(row => ({ date: row.date, value: row.didNotStart })) },
    ],
    checkoutVisitors: billing(data.checkoutVisitorBreakdown),
  }
}
