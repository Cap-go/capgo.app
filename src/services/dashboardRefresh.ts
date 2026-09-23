import { fetchOrgChartRefreshState as fetchOrgChartRefreshStateApi } from '~/services/organizations'
import { useSupabase } from '~/services/supabase'

export const CHART_REFRESH_STALE_MS = 5 * 60 * 1000
export const CHART_REFRESH_POLL_MS = 10 * 1000
export const CHART_REFRESH_TIMEOUT_MS = CHART_REFRESH_STALE_MS + CHART_REFRESH_POLL_MS

export interface ChartRefreshRequestResult {
  requested_at: string | null
  queued_app_ids: string[]
  queued_count: number
  skipped_count: number
}

export interface AppChartRefreshState {
  owner_org: string
  stats_refresh_requested_at: string | null
  stats_updated_at: string | null
}

export interface OrgChartRefreshState {
  stats_refresh_requested_at: string | null
  stats_updated_at: string | null
}

export function parseDashboardRefreshTimestamp(value: string | null | undefined): number | null {
  if (!value)
    return null

  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`
  const parsed = Date.parse(normalized)
  return Number.isNaN(parsed) ? null : parsed
}

export function isChartRefreshInProgress(
  requestedAt: string | null | undefined,
  updatedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const requestedMs = parseDashboardRefreshTimestamp(requestedAt)
  if (requestedMs === null)
    return false
  if (now - requestedMs >= CHART_REFRESH_TIMEOUT_MS)
    return false

  const updatedMs = parseDashboardRefreshTimestamp(updatedAt)
  return updatedMs === null || requestedMs > updatedMs
}

export function isChartDataStale(
  updatedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const updatedMs = parseDashboardRefreshTimestamp(updatedAt)
  if (updatedMs === null)
    return true

  return now - updatedMs > CHART_REFRESH_STALE_MS
}

export function shouldAutoRequestChartRefresh(
  updatedAt: string | null | undefined,
  requestedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  return isChartDataStale(updatedAt, now) && !isChartRefreshInProgress(requestedAt, updatedAt, now)
}

export function isOrgCacheReadyForRefresh(
  orgUpdatedAt: string | null | undefined,
  requestStartedAt: string | null | undefined,
): boolean {
  const requestStartedMs = parseDashboardRefreshTimestamp(requestStartedAt)
  if (requestStartedMs === null)
    return true

  const orgUpdatedMs = parseDashboardRefreshTimestamp(orgUpdatedAt)
  return orgUpdatedMs !== null && orgUpdatedMs >= requestStartedMs
}

export async function requestAppChartRefresh(appId: string): Promise<ChartRefreshRequestResult> {
  const { data, error } = await useSupabase()
    .rpc('request_app_chart_refresh', { app_id: appId })
    .single()

  if (error)
    throw error

  return {
    queued_app_ids: data?.queued_app_ids ?? [],
    queued_count: data?.queued_count ?? 0,
    requested_at: data?.requested_at ?? null,
    skipped_count: data?.skipped_count ?? 0,
  }
}

export async function requestOrgChartRefresh(orgId: string): Promise<ChartRefreshRequestResult> {
  const { data, error } = await useSupabase()
    .rpc('request_org_chart_refresh', { org_id: orgId })
    .single()

  if (error)
    throw error

  return {
    queued_app_ids: data?.queued_app_ids ?? [],
    queued_count: data?.queued_count ?? 0,
    requested_at: data?.requested_at ?? null,
    skipped_count: data?.skipped_count ?? 0,
  }
}

export async function fetchAppChartRefreshState(appId: string): Promise<AppChartRefreshState> {
  const { data, error } = await useSupabase()
    .from('apps')
    .select('owner_org,stats_updated_at,stats_refresh_requested_at')
    .eq('app_id', appId)
    .single()

  if (error || !data)
    throw error ?? new Error('App refresh state not found')

  return data
}

export async function fetchOrgChartRefreshState(orgId: string): Promise<OrgChartRefreshState> {
  const { data, error } = await fetchOrgChartRefreshStateApi(orgId)

  if (error || !data)
    throw error ?? new Error('Org refresh state not found')

  return data
}
