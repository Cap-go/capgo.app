export const OBSERVE_VIEWS = ['summary', 'metrics', 'events', 'device', 'versions', 'routes'] as const
export type ObserveView = typeof OBSERVE_VIEWS[number]

export const OBSERVE_SORTS = ['slowest', 'fastest', 'newest', 'oldest'] as const
export type ObserveSort = typeof OBSERVE_SORTS[number]

export const OBSERVE_PERIOD_DAYS = [1, 3, 7, 30] as const
export type ObservePeriodDays = typeof OBSERVE_PERIOD_DAYS[number]

export const OBSERVE_DEFAULT_DAYS: ObservePeriodDays = 7
export const OBSERVE_DEFAULT_LIMIT = 20
export const OBSERVE_MAX_LIMIT = 100
export const OBSERVE_SAMPLE_SCAN_LIMIT = 500

const SLOW_LAUNCH_P90_MS = 3_000
const CRITICAL_LAUNCH_P90_MS = 5_000
const ISSUE_FREE_WARNING = 95
const ISSUE_FREE_CRITICAL = 90

export interface ObserveFindingNext {
  view: ObserveView
  action?: string
  deviceId?: string
  sort?: ObserveSort
}

export interface ObserveFinding {
  id: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  detail: string
  next: ObserveFindingNext
}

export interface ObserveNavContract {
  listen: string
  metadata_keys: string[]
  example: {
    action: 'app_nav'
    metadata: { route: string, duration_ms: string, from?: string }
  }
}

export const OBSERVE_NAV_CONTRACT: ObserveNavContract = {
  listen: 'Listen to history.pushState, history.replaceState, popstate, hashchange, and Capacitor App appUrlOpen. No Expo Router required.',
  metadata_keys: ['route', 'path', 'from', 'duration_ms'],
  example: {
    action: 'app_nav',
    metadata: { route: '/checkout', duration_ms: '320', from: '/home' },
  },
}

export const OBSERVE_AGENT_INSTRUCTIONS
  = 'Start with view=summary. Follow each finding.next. Capgo has no session id: use view=device with device_id for the launch timeline. Sort metrics slowest to find outliers. Per-screen timings appear when the app reports metadata.route or action=app_nav (history/popstate/hashchange/appUrlOpen — no Expo Router).'

export interface ObserveActionBreakdownRow {
  action: string
  events: number
  devices: number
  p90_ms: number | null
  is_issue: boolean
}

export interface ObserveVersionRow {
  version_name: string
  devices: number
  issue_free_rate: number | null
  launch_p90_ms: number | null
}

export interface ObserveOverviewInput {
  total_events: number
  total_devices: number
  issue_count: number
  issue_free_rate: number | null
  launch_timeout_count: number
  launch_p90_ms: number | null
  webview_load_p90_ms: number | null
}

export interface ObserveSample {
  device_id: string
  action: string
  version_name: string
  created_at: string
  duration_ms: number | null
  route: string | null
  metadata: Record<string, string> | null
}

export interface ObserveRouteRow {
  route: string
  events: number
  devices: number
  p50_ms: number | null
  p90_ms: number | null
}

export function isObserveView(value: unknown): value is ObserveView {
  return typeof value === 'string' && (OBSERVE_VIEWS as readonly string[]).includes(value)
}

export function normalizeObserveDays(days: number | undefined): ObservePeriodDays | null {
  const value = days ?? OBSERVE_DEFAULT_DAYS
  if (!Number.isInteger(value) || !(OBSERVE_PERIOD_DAYS as readonly number[]).includes(value))
    return null
  return value as ObservePeriodDays
}

export function normalizeObserveSort(value: unknown): ObserveSort {
  if (typeof value === 'string' && (OBSERVE_SORTS as readonly string[]).includes(value))
    return value as ObserveSort
  return 'slowest'
}

export function normalizeObserveLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    return OBSERVE_DEFAULT_LIMIT
  return Math.min(OBSERVE_MAX_LIMIT, Math.max(1, value))
}

export function extractRoute(metadata: Record<string, string> | null | undefined): string | null {
  if (!metadata)
    return null
  for (const key of ['route', 'path', 'url'] as const) {
    const raw = metadata[key]?.trim()
    if (raw)
      return raw.slice(0, 200)
  }
  return null
}

export function buildObserveFindings(input: {
  overview: ObserveOverviewInput
  actionBreakdown: ObserveActionBreakdownRow[]
  versions: ObserveVersionRow[]
}): ObserveFinding[] {
  const findings: ObserveFinding[] = []
  const { overview } = input

  if (overview.total_events <= 0) {
    findings.push({
      id: 'no_data',
      severity: 'info',
      title: 'No observe events in this period',
      detail: 'Ship a newer updater plugin so launch, WebView, crash, and navigation events report here.',
      next: { view: 'summary' },
    })
    return findings
  }

  const launchP90 = overview.launch_p90_ms
  if (launchP90 != null && launchP90 >= CRITICAL_LAUNCH_P90_MS) {
    findings.push({
      id: 'launch_p90_critical',
      severity: 'critical',
      title: 'Launch P90 is critically slow',
      detail: `Launch P90 is ${Math.round(launchP90)}ms (target under ${SLOW_LAUNCH_P90_MS}ms). Inspect the slowest app_launch_ready samples.`,
      next: { view: 'metrics', action: 'app_launch_ready', sort: 'slowest' },
    })
  }
  else if (launchP90 != null && launchP90 >= SLOW_LAUNCH_P90_MS) {
    findings.push({
      id: 'launch_p90_slow',
      severity: 'warning',
      title: 'Launch P90 is slow',
      detail: `Launch P90 is ${Math.round(launchP90)}ms. Sort metrics slowest-first for app_launch_ready.`,
      next: { view: 'metrics', action: 'app_launch_ready', sort: 'slowest' },
    })
  }

  if (overview.launch_timeout_count > 0) {
    findings.push({
      id: 'launch_timeouts',
      severity: 'warning',
      title: 'Launch timeouts reported',
      detail: `${overview.launch_timeout_count} app_launch_timeout events. Open the slowest devices next.`,
      next: { view: 'events', action: 'app_launch_timeout', sort: 'newest' },
    })
  }

  const issueFree = overview.issue_free_rate
  if (issueFree != null && issueFree < ISSUE_FREE_CRITICAL) {
    findings.push({
      id: 'issue_free_critical',
      severity: 'critical',
      title: 'Issue-free rate is low',
      detail: `${issueFree.toFixed(1)}% of devices had no native/WebView issue. Inspect the top issue action.`,
      next: { view: 'events', sort: 'newest' },
    })
  }
  else if (issueFree != null && issueFree < ISSUE_FREE_WARNING) {
    findings.push({
      id: 'issue_free_warning',
      severity: 'warning',
      title: 'Issue-free rate dropped',
      detail: `${issueFree.toFixed(1)}% of devices had no native/WebView issue.`,
      next: { view: 'events', sort: 'newest' },
    })
  }

  const topIssue = input.actionBreakdown.find(row => row.is_issue && row.events > 0)
  if (topIssue) {
    findings.push({
      id: 'top_issue',
      severity: topIssue.action.includes('crash') || topIssue.action === 'app_anr' ? 'critical' : 'warning',
      title: `Top issue is ${topIssue.action}`,
      detail: `${topIssue.events} events on ${topIssue.devices} devices. Open device timelines after picking a sample.`,
      next: { view: 'events', action: topIssue.action, sort: 'newest' },
    })
  }

  const webviewP90 = overview.webview_load_p90_ms
  if (webviewP90 != null && webviewP90 >= SLOW_LAUNCH_P90_MS) {
    findings.push({
      id: 'webview_p90_slow',
      severity: 'warning',
      title: 'WebView load P90 is slow',
      detail: `WebView page load P90 is ${Math.round(webviewP90)}ms. Check routes if metadata.route is present.`,
      next: { view: 'routes', action: 'webview_page_loaded', sort: 'slowest' },
    })
  }

  const worstVersion = [...input.versions]
    .filter(row => row.launch_p90_ms != null && row.devices > 0)
    .sort((a, b) => (b.launch_p90_ms ?? 0) - (a.launch_p90_ms ?? 0))[0]
  if (worstVersion && (worstVersion.launch_p90_ms ?? 0) >= SLOW_LAUNCH_P90_MS) {
    findings.push({
      id: 'slow_version',
      severity: 'warning',
      title: `Version ${worstVersion.version_name} launches slowly`,
      detail: `Launch P90 ${Math.round(worstVersion.launch_p90_ms ?? 0)}ms on ${worstVersion.devices} devices.`,
      next: { view: 'metrics', action: 'app_launch_ready', sort: 'slowest' },
    })
  }

  if (findings.length === 0) {
    findings.push({
      id: 'healthy',
      severity: 'info',
      title: 'No obvious Observe regressions',
      detail: 'Launch and issue rates look healthy for this window. Use metrics slowest-first or routes if you still suspect a screen.',
      next: { view: 'metrics', action: 'app_launch_ready', sort: 'slowest' },
    })
  }

  return findings
}

export function buildObserveHandoffPrompt(input: {
  appId: string
  days: number
  overview: ObserveOverviewInput
  findings: ObserveFinding[]
}): string {
  const lines = [
    `Capgo Observe for ${input.appId}, last ${input.days} day(s).`,
    `Devices ${input.overview.total_devices}, events ${input.overview.total_events}, launch P90 ${formatMs(input.overview.launch_p90_ms)}, issue-free ${formatPct(input.overview.issue_free_rate)}.`,
    OBSERVE_AGENT_INSTRUCTIONS,
    'Findings:',
    ...input.findings.map(finding => `- [${finding.severity}] ${finding.title}: ${finding.detail} Next view=${finding.next.view}${finding.next.action ? ` action=${finding.next.action}` : ''}${finding.next.sort ? ` sort=${finding.next.sort}` : ''}.`),
  ]
  return lines.join('\n')
}

function formatMs(value: number | null) {
  return value == null ? 'n/a' : `${Math.round(value)}ms`
}

function formatPct(value: number | null) {
  return value == null ? 'n/a' : `${value.toFixed(1)}%`
}

export function toObserveSample(row: {
  device_id?: string
  action?: string
  version_name?: string
  created_at?: string
  metadata?: Record<string, string> | string | null
  duration_ms?: number | null
}): ObserveSample {
  const metadata = normalizeMetadata(row.metadata)
  const durationFromRow = typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms) ? row.duration_ms : null
  return {
    device_id: row.device_id ?? '',
    action: row.action ?? '',
    version_name: row.version_name || 'unknown',
    created_at: row.created_at ?? '',
    duration_ms: durationFromRow ?? parseDurationMs(metadata),
    route: extractRoute(metadata),
    metadata,
  }
}

function normalizeMetadata(metadata: Record<string, string> | string | null | undefined): Record<string, string> | null {
  if (!metadata)
    return null
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return null
      return parsed as Record<string, string>
    }
    catch {
      return null
    }
  }
  return metadata
}

function parseDurationMs(metadata: Record<string, string> | null): number | null {
  if (!metadata)
    return null
  for (const key of ['duration_ms', 'duration'] as const) {
    const raw = metadata[key]
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0)
      return raw
    if (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw)) {
      const value = Number(raw)
      if (Number.isFinite(value) && value >= 0)
        return value
    }
  }
  return null
}

export function sortObserveSamples(samples: ObserveSample[], sort: ObserveSort): ObserveSample[] {
  const copy = [...samples]
  copy.sort((a, b) => {
    if (sort === 'slowest')
      return (b.duration_ms ?? -1) - (a.duration_ms ?? -1)
    if (sort === 'fastest')
      return (a.duration_ms ?? Number.POSITIVE_INFINITY) - (b.duration_ms ?? Number.POSITIVE_INFINITY)
    const aTime = Date.parse(a.created_at)
    const bTime = Date.parse(b.created_at)
    if (sort === 'newest')
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
    return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0)
  })
  return copy
}

function percentileCont(sorted: number[], q: number): number | null {
  if (!sorted.length)
    return null
  if (sorted.length === 1)
    return sorted[0]!
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper)
    return sorted[lower]!
  const weight = index - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

export function groupObserveRoutes(samples: ObserveSample[]): ObserveRouteRow[] {
  const groups = new Map<string, { events: number, devices: Set<string>, durations: number[] }>()
  for (const sample of samples) {
    const route = sample.route
    if (!route)
      continue
    const group = groups.get(route) ?? { events: 0, devices: new Set<string>(), durations: [] }
    group.events += 1
    if (sample.device_id)
      group.devices.add(sample.device_id)
    if (sample.duration_ms != null)
      group.durations.push(sample.duration_ms)
    groups.set(route, group)
  }

  return [...groups.entries()]
    .map(([route, group]) => {
      const sorted = [...group.durations].sort((a, b) => a - b)
      return {
        route,
        events: group.events,
        devices: group.devices.size,
        p50_ms: percentileCont(sorted, 0.5),
        p90_ms: percentileCont(sorted, 0.9),
      }
    })
    .sort((a, b) => (b.p90_ms ?? -1) - (a.p90_ms ?? -1) || b.events - a.events)
}
