import type { SupabaseClient } from '@supabase/supabase-js'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { CreditMetricType, CreditPricingStep } from './creditPricing'
import type { Database } from '~/types/supabase.types'
import { format, parse } from '@std/semver'
import { createClient } from '@supabase/supabase-js'
import subset from 'semver/ranges/subset'
import { ref } from 'vue'
import { getFirstTierCreditUnitPricing, sortCreditPricingSteps } from './creditPricing'

let supaClient: SupabaseClient<Database> = null as any

export const defaultApiHost = import.meta.env.VITE_API_HOST as string

export interface CapgoConfig {
  supaHost: string
  supaKey: string
  supbaseId: string
  host: string
  hostWeb: string
  stripeEnabled?: boolean
}

export function isLocal(supaHost: string) {
  return supaHost !== 'https://sb.capgo.app'
}

export function getLocalConfig() {
  const stripeEnabledEnv = import.meta.env.VITE_STRIPE_ENABLED as string | undefined
  return {
    supaHost: import.meta.env.VITE_SUPABASE_URL as string,
    supaKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    supbaseId: import.meta.env.VITE_SUPABASE_URL?.split('//')[1].split('.')[0].split(':')[0] as string,
    host: import.meta.env.VITE_APP_URL as string,
    hostWeb: import.meta.env.LANDING_URL as string,
    stripeEnabled: stripeEnabledEnv === undefined ? true : stripeEnabledEnv !== 'false',
  } as CapgoConfig
}

let config: CapgoConfig = getLocalConfig()
export const stripeEnabled = ref<boolean>(config.stripeEnabled ?? true)

interface SpoofedAdminSession {
  jwt: string
  refreshToken: string
}

const SPOOF_ADMIN_TOKEN_REFRESH_WINDOW_SECONDS = 60

function getSpoofedAdminStorageKey() {
  return `supabase-${config.supbaseId}.spoof_admin_jwt`
}

function saveSpoofedAdminSession(session: SpoofedAdminSession) {
  return localStorage.setItem(getSpoofedAdminStorageKey(), JSON.stringify({ jwt: session.jwt, refreshToken: session.refreshToken }))
}

function getSpoofedAdminSession(): SpoofedAdminSession | null {
  const textData = localStorage.getItem(getSpoofedAdminStorageKey())
  if (!textData)
    return null

  try {
    const parsed = JSON.parse(textData) as Partial<SpoofedAdminSession>
    if (typeof parsed.jwt !== 'string' || !parsed.jwt)
      return null
    if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken)
      return null
    return { jwt: parsed.jwt, refreshToken: parsed.refreshToken }
  }
  catch {
    return null
  }
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return globalThis.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
}

function getJwtExpiresAt(jwt: string) {
  const payload = jwt.split('.')[1]
  if (!payload)
    return null

  try {
    const parsed = JSON.parse(decodeBase64Url(payload)) as { exp?: unknown }
    return typeof parsed.exp === 'number' ? parsed.exp : null
  }
  catch {
    return null
  }
}

function shouldRefreshSpoofedAdminJwt(jwt: string) {
  const expiresAt = getJwtExpiresAt(jwt)
  if (!expiresAt)
    return true

  return expiresAt - Date.now() / 1000 <= SPOOF_ADMIN_TOKEN_REFRESH_WINDOW_SECONDS
}

function createSpoofAdminSupabase() {
  return createClient<Database>(getSupabaseHost(), config.supaKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
}

async function refreshSpoofedAdminSession(session: SpoofedAdminSession): Promise<SpoofedAdminSession | null> {
  const { data, error } = await createSpoofAdminSupabase().auth.refreshSession({ refresh_token: session.refreshToken })
  if (error || !data.session?.access_token || !data.session.refresh_token)
    return null

  return { jwt: data.session.access_token, refreshToken: data.session.refresh_token }
}

export function mergeRemoteConfig(localConfig: CapgoConfig, remoteConfig: Partial<CapgoConfig> | null | undefined): CapgoConfig {
  return {
    ...localConfig,
    host: typeof remoteConfig?.host === 'string' ? remoteConfig.host : localConfig.host,
    hostWeb: typeof remoteConfig?.hostWeb === 'string' ? remoteConfig.hostWeb : localConfig.hostWeb,
    stripeEnabled: typeof remoteConfig?.stripeEnabled === 'boolean' ? remoteConfig.stripeEnabled : localConfig.stripeEnabled,
  }
}

export async function getRemoteConfig() {
  const localConfig = getLocalConfig()
  if (import.meta.env.MODE === 'development')
    return localConfig

  try {
    const response = await fetch(`${defaultApiHost}/private/config`)
    if (!response.ok) {
      console.log('Local config', localConfig)
      stripeEnabled.value = localConfig.stripeEnabled ?? stripeEnabled.value
      return localConfig as CapgoConfig
    }
    const data = await response.json() as Partial<CapgoConfig>
    const merged = mergeRemoteConfig(localConfig, data)
    config = merged
    stripeEnabled.value = merged.stripeEnabled ?? stripeEnabled.value
    return merged
  }
  catch {
    console.log('Local config', localConfig)
    stripeEnabled.value = localConfig.stripeEnabled ?? stripeEnabled.value
    return localConfig as CapgoConfig
  }
}

export function getSupabaseHost(): string {
  let host = config.supaHost
  while (host.endsWith('/'))
    host = host.slice(0, -1)
  return host
}

export function useSupabase() {
  const options = {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
  if (supaClient)
    return supaClient

  supaClient = createClient<Database>(getSupabaseHost(), config.supaKey, options)
  return supaClient
}

export function isSpoofed() {
  return !!getSpoofedAdminSession()
}
export function saveSpoof(jwt: string, refreshToken: string) {
  return saveSpoofedAdminSession({ jwt, refreshToken })
}

export function clearSpoof() {
  localStorage.removeItem(getSpoofedAdminStorageKey())
}

export async function getSpoofedAdminJwt() {
  const spoofedAdminSession = getSpoofedAdminSession()
  if (!spoofedAdminSession)
    return null

  if (!shouldRefreshSpoofedAdminJwt(spoofedAdminSession.jwt))
    return spoofedAdminSession.jwt

  try {
    const refreshedSession = await refreshSpoofedAdminSession(spoofedAdminSession)
    if (refreshedSession) {
      saveSpoofedAdminSession(refreshedSession)
      return refreshedSession.jwt
    }
  }
  catch {
    console.error('Failed to refresh spoofed admin session')
  }

  const expiresAt = getJwtExpiresAt(spoofedAdminSession.jwt)
  if (expiresAt && expiresAt > Date.now() / 1000)
    return spoofedAdminSession.jwt

  clearSpoof()
  return null
}

export async function hashEmail(email: string) {
  const encoder = new TextEncoder()
  const data = encoder.encode(email)

  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('')
  return hashHex
}

export async function unspoofUser() {
  const spoofedAdminSession = getSpoofedAdminSession()
  if (!spoofedAdminSession)
    return false

  const restoredAdminSession = await refreshSpoofedAdminSession(spoofedAdminSession).catch(() => null)
  if (!restoredAdminSession) {
    clearSpoof()
    return false
  }

  const supabase = useSupabase()
  const { data, error } = await supabase.auth.setSession({ access_token: restoredAdminSession.jwt, refresh_token: restoredAdminSession.refreshToken })
  clearSpoof()

  if (error || !data.session)
    return false

  return true
}

export async function downloadUrl(provider: string, userId: string, appId: string, id: number): Promise<string> {
  const data = {
    user_id: userId,
    app_id: appId,
    storage_provider: provider,
    id,
  }
  const { data: currentSession } = await useSupabase().auth.getSession()!
  if (!currentSession.session)
    return ''

  const currentJwt = currentSession.session.access_token

  try {
    const response = await fetch(`${defaultApiHost}/files/download_link`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw new Error(`downloadUrl error: HTTP ${response.status}`)
    }

    const res = await response.json() as { url: string }
    return res.url
  }
  catch (e) {
    throw new Error(`downloadUrl error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function autoAuth(route: RouteLocationNormalizedLoaded) {
  const supabase = useSupabase()
  const { data: session } = await supabase.auth.getSession()!
  if (session.session || !route.hash)
    return null
  const queryString = route.hash.replace('#', '')
  const urlParams = new URLSearchParams(queryString)
  const refresh_token = urlParams.get('refresh_token')
  if (!refresh_token)
    return null
  const { data: logSession } = await supabase.auth.refreshSession({
    refresh_token,
  })
  return logSession
}

export interface AppUsageByApp {
  app_id: string
  date: string
  mau: number
  storage: number
  storage_byte_hours?: number
  bandwidth: number
  build_time_seconds: number
  get: number
}

export interface AppUsageGlobal {
  date: string
  bandwidth: number
  mau: number
  storage: number
  storage_byte_hours?: number
  build_time_seconds: number
  get: number
}

export interface AppUsageGlobalByApp {
  global: AppUsageGlobal[]
  byApp: AppUsageByApp[]
}

function parseDashboardRangeDate(value?: string) {
  if (!value)
    return null

  const dateParts = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/)
  if (!dateParts)
    return null

  const [year, month, day] = dateParts.slice(1).map(Number)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()))
    return null

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    return null
  }

  return parsed
}

export function normalizeDashboardDateRange(startDate?: string, endDate?: string, now: Date = new Date()) {
  const fallbackEnd = new Date(now)
  fallbackEnd.setHours(0, 0, 0, 0)
  fallbackEnd.setDate(fallbackEnd.getDate() + 1)

  const fallbackStart = new Date(fallbackEnd)
  fallbackStart.setDate(fallbackStart.getDate() - 30)

  const parsedStart = parseDashboardRangeDate(startDate)
  const parsedEnd = parseDashboardRangeDate(endDate)
  const resolvedStart = parsedStart && parsedEnd ? parsedStart : fallbackStart
  const resolvedEnd = parsedStart && parsedEnd ? parsedEnd : fallbackEnd

  if (resolvedStart.getTime() > resolvedEnd.getTime()) {
    return {
      start: fallbackStart.toISOString(),
      end: fallbackEnd.toISOString(),
    }
  }

  return {
    start: resolvedStart.toISOString(),
    end: resolvedEnd.toISOString(),
  }
}

export async function getAllDashboard(orgId: string, startDate?: string, endDate?: string): Promise<AppUsageGlobalByApp> {
  try {
    const supabase = useSupabase()
    const { start, end } = normalizeDashboardDateRange(startDate, endDate)
    const dateRange = `?from=${start}&to=${end}&breakdown=true&noAccumulate=true`

    // 🚀 SUPER OPTIMIZED: Single API call returns both aggregated AND per-app breakdown (with daily values, not accumulated)
    const response = await supabase.functions.invoke(`statistics/org/${orgId}/${dateRange}`, {
      method: 'GET',
    })

    if (response.error) {
      throw new Error(response.error.message)
    }

    const { global, byApp } = response.data as {
      global: { mau: number, storage: number, storage_byte_hours?: number, bandwidth: number, build_time_seconds: number, date: string, get: number }[]
      byApp: { app_id: string, mau: number, storage: number, storage_byte_hours?: number, bandwidth: number, build_time_seconds: number, date: string, get: number }[]
    }

    return {
      global: global.sort((a, b) => a.date.localeCompare(b.date)),
      byApp: byApp.sort((a, b) => a.date.localeCompare(b.date)),
    }
  }
  catch (error) {
    console.error('Error in getAllDashboard:', error)
    throw error
  }
}
interface NativePackage {
  name: string
  version: string
}

export async function getCapgoVersion(appId: string, versionId: string | null | undefined): Promise<string> {
  if (!versionId)
    return ''
  const { data, error } = await useSupabase()
    .from('app_versions')
    .select('native_packages')
    .eq('app_id', appId)
    .eq('name', versionId)
    .single()

  if (error)
    return ''

  const nativePackages: NativePackage[] = (data?.native_packages ?? []) as any as NativePackage[]
  for (const pkg of nativePackages) {
    if (pkg && pkg.name === '@capgo/capacitor-updater') {
      return format(parse(pkg.version.replace('^', '').replace('~', '')))
    }
  }
  return ''
}

export async function getTotalStorage(orgId?: string): Promise<number> {
  if (!orgId)
    return 0
  const { data, error } = await useSupabase()
    .rpc('get_total_storage_size_org', { org_id: orgId })
    .single()
  if (error)
    throw new Error(error.message)

  return data ?? 0
}

// Canonical frontend platform-admin verification.
// Use this only for platform-rights checks in the UI flow; no other path should use
// user-id based admin function checks from the browser.
export async function isPlatformAdmin(): Promise<boolean> {
  const rpc = useSupabase().rpc('is_platform_admin')
  const { data, error } = await rpc.single()
  if (error)
    throw new Error(error.message)

  return data ?? false
}

export async function isPayingOrg(orgId: string): Promise<boolean> {
  const { data, error } = await useSupabase()
    .rpc('is_paying_org', { orgid: orgId })
    .single()
  if (error)
    console.error('isPayingOrg error', orgId, error)

  return data ?? false
}

export async function getPlans(): Promise<Database['public']['Tables']['plans']['Row'][]> {
  try {
    const response = await fetch(`${defaultApiHost}/private/plans`)

    if (!response.ok) {
      return []
    }

    return await response.json() as Database['public']['Tables']['plans']['Row'][]
  }
  catch {
    return []
  }
}

export type CreditUnitPricing = Partial<Record<CreditMetricType, number>>
export type UsageCreditLedgerRow = Database['public']['Views']['usage_credit_ledger']['Row']

export interface CreditTierUsage {
  tier_id: number
  step_min: number
  step_max: number
  unit_factor: number
  units_used: number
  price_per_unit: number
  cost: number
}

export interface CreditMetricBreakdown {
  cost: number
  tiers: CreditTierUsage[]
}

export interface CreditCostCalculationRequest {
  mau: number
  bandwidth: number
  storage: number
  build_time?: number
  org_id?: string
}

export interface CreditCostCalculationResponse {
  total_cost: number
  breakdown: Record<CreditMetricType, CreditMetricBreakdown>
  usage: {
    mau: number
    bandwidth: number
    storage: number
    build_time: number
  }
}

export async function getCreditPricingSteps(orgId?: string): Promise<CreditPricingStep[]> {
  try {
    const supabase = useSupabase()
    const { data: currentSession } = await supabase.auth.getSession()
    const endpoint = new URL(`${defaultApiHost}/private/credits`)

    if (orgId)
      endpoint.searchParams.set('org_id', orgId)

    const response = await fetch(endpoint.toString(), {
      headers: currentSession.session?.access_token
        ? {
            Authorization: `Bearer ${currentSession.session.access_token}`,
          }
        : undefined,
    })

    if (!response.ok)
      throw new Error(`Failed to fetch credit pricing: HTTP ${response.status}`)

    const data = await response.json() as CreditPricingStep[]
    return sortCreditPricingSteps(data ?? [])
  }
  catch (err) {
    console.error('getCreditPricingSteps error', err)
    return []
  }
}

export async function getCreditUnitPricing(orgId?: string): Promise<CreditUnitPricing> {
  try {
    const steps = await getCreditPricingSteps(orgId)
    return getFirstTierCreditUnitPricing(steps)
  }
  catch (err) {
    console.error('getCreditUnitPricing error', err)
    return {}
  }
}

export async function getUsageCreditDeductions(orgId: string): Promise<UsageCreditLedgerRow[]> {
  if (!orgId)
    return []

  try {
    const { data, error } = await useSupabase()
      .from('usage_credit_ledger')
      .select('*')
      .eq('org_id', orgId)
      .eq('transaction_type', 'deduction')
      .order('occurred_at', { ascending: false })

    if (error)
      throw new Error(error.message)

    return data ?? []
  }
  catch (err) {
    console.error('getUsageCreditDeductions error', err)
    return []
  }
}

export async function calculateCreditCost(request: CreditCostCalculationRequest): Promise<CreditCostCalculationResponse> {
  const response = await useSupabase().functions.invoke('private/credits', {
    body: {
      ...request,
      build_time: request.build_time ?? 0,
    },
  })

  if (response.error)
    throw new Error(response.error.message)

  return response.data as CreditCostCalculationResponse
}

interface PlanUsage {
  total_percent: number
  mau_percent: number
  bandwidth_percent: number
  storage_percent: number
  build_time_percent: number
}

export async function getPlanUsagePercent(orgId?: string): Promise<PlanUsage> {
  if (!orgId) {
    return {
      total_percent: 0,
      mau_percent: 0,
      bandwidth_percent: 0,
      storage_percent: 0,
      build_time_percent: 0,
    }
  }
  const { data, error } = await useSupabase()
    .rpc('get_plan_usage_percent_detailed', { orgid: orgId })
    .single()
  if (error)
    throw new Error(error.message)
  return data
}

const DEFAULT_PLAN_NAME = 'Solo'

export async function getCurrentPlanNameOrg(orgId?: string): Promise<string> {
  if (!orgId)
    return DEFAULT_PLAN_NAME
  const { data, error } = await useSupabase()
    .rpc('get_current_plan_name_org', { orgid: orgId })
    .single()
  if (error)
    throw new Error(error.message)

  return data ?? DEFAULT_PLAN_NAME
}

export async function findBestPlan(stats: Database['public']['Functions']['find_best_plan_v3']['Args']): Promise<string> {
  // console.log('findBestPlan', stats)
  // const storage = bytesToGb(stats.storage)
  // const bandwidth = bytesToGb(stats.bandwidth)
  const { data, error } = await useSupabase()
    .rpc('find_best_plan_v3', {
      mau: stats.mau ?? 0,
      bandwidth: stats.bandwidth,
      storage: stats.storage,
    })
    .single()
  if (error)
    throw new Error(error.message)

  return data
}

export function convertNativePackages(nativePackages: { name: string, version: string }[]) {
  if (!nativePackages) {
    throw new Error(`Error parsing native packages, perhaps the metadata does not exist in Capgo?`)
  }

  // Check types
  nativePackages.forEach((data) => {
    if (typeof data !== 'object') {
      throw new TypeError(`Invalid remote native package data: ${data}, expected object, got ${typeof data}`)
    }

    const { name, version } = data
    if (!name || typeof name !== 'string') {
      throw new Error(`Invalid remote native package name: ${name}, expected string, got ${typeof name}`)
    }

    if (!version || typeof version !== 'string') {
      throw new TypeError(`Invalid remote native package version: ${version}, expected string, got ${typeof version}`)
    }
  })

  const mappedRemoteNativePackages = new Map((nativePackages)
    .map(a => [a.name, a]))

  return mappedRemoteNativePackages
}

export async function getRemoteDependencies(appId: string, channel: string) {
  const { data: remoteNativePackages, error } = await useSupabase()
    .from('channels')
    .select(`version:app_versions!channels_version_fkey(
            native_packages
        )`)
    .eq('name', channel)
    .eq('app_id', appId)
    .single()

  if (error) {
    throw new Error(error.message)
  }
  const version = remoteNativePackages.version as { native_packages?: { name: string, version: string }[] | null } | null
  const nativePackages = version?.native_packages
  if (!nativePackages)
    throw new Error('Error parsing native packages, perhaps the metadata does not exist in Capgo?')
  return convertNativePackages(nativePackages)
}

interface Compatibility {
  name: string
  localVersion: string | undefined
  remoteVersion: string | undefined
}

export function isCompatible(pkg: Compatibility): boolean {
  // Only check compatibility if there's a local version
  // If there's a local version but no remote version, or versions don't match, it's incompatible
  if (!pkg.localVersion)
    return true // If no local version, it's compatible (remote-only package)
  if (!pkg.remoteVersion)
    return false // If local version but no remote version, it's incompatible
  try {
    return subset(pkg.localVersion, pkg.remoteVersion)
  }
  catch {
    return false // If version comparison fails, consider it incompatible
  }
}

export async function checkCompatibilityNativePackages(appId: string, channel: string, nativePackages: { name: string, version: string }[]) {
  const mappedRemoteNativePackages = await getRemoteDependencies(appId, channel)

  const finalDependencies: Compatibility[] = nativePackages
    .map((local) => {
      const remotePackage = mappedRemoteNativePackages.get(local.name)
      if (remotePackage) {
        return {
          name: local.name,
          localVersion: local.version,
          remoteVersion: remotePackage.version,
        }
      }

      return {
        name: local.name,
        localVersion: local.version,
        remoteVersion: undefined,
      }
    })

  // Only include remote packages that are not in local for informational purposes
  // These won't affect compatibility
  const removeNotInLocal = [...mappedRemoteNativePackages]
    .filter(([remoteName]) => nativePackages.find(a => a.name === remoteName) === undefined)
    .map(([name, version]) => ({ name, localVersion: undefined, remoteVersion: version.version }))

  finalDependencies.push(...removeNotInLocal)

  return {
    finalCompatibility: finalDependencies,
    localDependencies: nativePackages,
  }
}
