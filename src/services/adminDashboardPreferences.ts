import type { Json } from '~/types/supabase.types'

export type AdminDashboardMinimize = Record<string, boolean>

const ADMIN_DASHBOARD_MINIMIZE_KEY = 'admin_dashboard_minimize'

function isJsonObject(value: Json | undefined): value is { [key: string]: Json | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasAdminDashboardMinimize(onboarding: Json | undefined): boolean {
  return isJsonObject(onboarding) && isJsonObject(onboarding[ADMIN_DASHBOARD_MINIMIZE_KEY])
}

export function readAdminDashboardMinimize(onboarding: Json | undefined): AdminDashboardMinimize {
  if (!isJsonObject(onboarding))
    return {}

  const stored = onboarding[ADMIN_DASHBOARD_MINIMIZE_KEY]
  if (!isJsonObject(stored))
    return {}

  return Object.fromEntries(
    Object.entries(stored)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  )
}

export function withAdminDashboardMinimize(
  onboarding: Json | undefined,
  preferences: AdminDashboardMinimize,
): Json {
  const current = isJsonObject(onboarding) ? onboarding : {}
  return {
    ...current,
    [ADMIN_DASHBOARD_MINIMIZE_KEY]: { ...preferences },
  }
}

export function preserveAdminDashboardMinimize(
  nextOnboarding: Json,
  currentOnboarding: Json | undefined,
  isAdmin: boolean,
): Json {
  if (!isAdmin || !hasAdminDashboardMinimize(currentOnboarding))
    return nextOnboarding

  return withAdminDashboardMinimize(
    nextOnboarding,
    readAdminDashboardMinimize(currentOnboarding),
  )
}

function slugify(value: string, fallback: string, maxLength: number): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')

  return slug || fallback
}

function stableHash(value: string): string {
  let hash = 0x811C9DC5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function createAdminDashboardChartPreferenceKey(routePath: string, chartId: string): string {
  const routeSegments = routePath.split('/').filter(Boolean)
  const routeSegment = routeSegments[routeSegments.length - 1] ?? 'dashboard'
  const routeSlug = slugify(routeSegment, 'dashboard', 24)
  const chartSlug = slugify(chartId, 'chart', 32)
  return `${routeSlug}.${chartSlug}.${stableHash(`${routePath}\0${chartId}`)}`
}
