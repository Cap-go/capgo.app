import type { SupabaseClient } from '@supabase/supabase-js'
import type { Context } from 'hono'
import type { BillingPlanBentoState } from './billing_bento_tags.ts'
import type { AuthInfo } from './hono.ts'
import type { Database } from './supabase.types.ts'
import type { DeviceWithoutCreatedAt, NativeVersionUsage, Order, ReadDevicesParams, ReadStatsInsightsParams, ReadStatsParams, StatsInsightsResult, StatsMetadata, VersionUsage, VersionUsageChannel } from './types.ts'
import { createClient } from '@supabase/supabase-js'
import { buildBillingPlanBentoTags } from './billing_bento_tags.ts'
import { buildNormalizedDeviceForWrite, hasComparableDeviceChanged, nullableString } from './deviceComparison.ts'
import { simpleError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { emptyStatsInsights, normalizeStatsInsightsResult } from './statsInsights.ts'
import { Constants } from './supabase.types.ts'
import { getEnv, isStripeConfigured } from './utils.ts'

const DEFAULT_LIMIT = 1000
// Import Supabase client

/**
 * Escape a string and wrap it in double quotes for safely embedding into PostgREST filter payloads.
 */
function quotePostgrestFilterValue(value: string): string {
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escapedValue}"`
}

/**
 * Return a PostgREST `ilike` pattern that matches the provided value as a substring.
 */
function buildIlikeContainsPattern(value: string): string {
  return quotePostgrestFilterValue(`%${value}%`)
}

/**
 * Derive whether the device cursor should sort ascending or descending by `updated_at`.
 */
type DevicesOrder = {
  ascending: boolean
} | null

function getDevicesOrder(order?: Order[]): DevicesOrder {
  const activeOrder = order?.find(
    col => col.key === 'updated_at' && typeof col.sortable === 'string',
  )

  if (!activeOrder)
    return null

  return {
    ascending: activeOrder.sortable === 'asc',
  }
}

export interface InsertPayload<T extends keyof Database['public']['Tables']> {
  type: 'INSERT'
  table: string
  schema: string
  record: Database['public']['Tables'][T]['Insert']
  old_record: null
}
export interface UpdatePayload<T extends keyof Database['public']['Tables']> {
  type: 'UPDATE'
  table: string
  schema: string
  record: Database['public']['Tables'][T]['Update']
  old_record: Database['public']['Tables'][T]['Row']
}
export interface DeletePayload<T extends keyof Database['public']['Tables']> {
  type: 'DELETE'
  table: string
  schema: string
  record: null
  old_record: Database['public']['Tables'][T]['Row']
}

export function supabaseClient(c: Context, jwt: string) {
  const options = {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers: { Authorization: jwt } },
  }
  return createClient<Database>(getEnv(c, 'SUPABASE_URL'), getEnv(c, 'SUPABASE_ANON_KEY'), options)
}

export function supabaseWithAuth(c: Context, auth: AuthInfo) {
  if (auth.authType === 'jwt' && auth.jwt) {
    return supabaseClient(c, auth.jwt)
  }
  else if (auth.authType === 'apikey' && auth.apikey) {
    // supabaseApikey now handles the fallback to capgkey for hashed keys
    return supabaseApikey(c, auth.apikey.key)
  }
  else {
    throw simpleError('not_authorized', 'Not authorized')
  }
}

export function emptySupabase(c: Context) {
  const options = {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
  return createClient<Database>(getEnv(c, 'SUPABASE_URL'), getEnv(c, 'SUPABASE_ANON_KEY'), options)
}

// WARNING: The service role key has admin privileges and should only be used in secure server environments!
export function supabaseAdmin(c: Context) {
  const serviceRoleKey = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  const options = {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
  return createClient<Database>(getEnv(c, 'SUPABASE_URL'), serviceRoleKey, options)
}

export function supabaseApikey(c: Context, apikey: string | null | undefined) {
  // For hashed keys, the key column is null, so we use the capgkey from the request header
  const effectiveApikey = apikey ?? c.get('capgkey')
  if (!effectiveApikey) {
    throw new Error('No API key available for authentication')
  }
  cloudlog({ requestId: c.get('requestId'), message: 'supabaseApikey', apikeyPrefix: effectiveApikey.substring(0, 8) })
  return createClient<Database>(getEnv(c, 'SUPABASE_URL'), getEnv(c, 'SUPABASE_ANON_KEY'), {
    auth: {
      persistSession: false,
    },
    global: {
      headers: {
        capgkey: effectiveApikey,
      },
    },
  })
}

export async function getAppsFromSB(c: Context, referenceDate?: Date): Promise<string[]> {
  const limit = 1000
  const createdBeforeIso = referenceDate?.toISOString()
  let page = 0
  let apps: string[] = []

  while (true) {
    let query = supabaseAdmin(c)
      .from('apps')
      .select('app_id')
      .range(page * limit, (page + 1) * limit - 1)

    if (createdBeforeIso)
      query = query.lt('created_at', createdBeforeIso)

    const { data, error } = await query

    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting apps from Supabase', error })
      break
    }

    if (data.length === 0)
      break

    apps = [...apps, ...data.map(row => row.app_id)]
    page++
  }

  if (createdBeforeIso) {
    const pgClient = getPgClient(c, false)

    try {
      page = 0
      while (true) {
        const { rows } = await pgClient.query<{ app_id: string }>(
          `SELECT app_id
          FROM public.deleted_apps
          WHERE (
            created_at < $1::timestamptz
            -- Legacy rows used created_at=deleted_at before on_app_delete copied the original app timestamp.
            OR created_at = deleted_at
          )
            AND deleted_at >= $1::timestamptz
          ORDER BY app_id
          LIMIT $2 OFFSET $3`,
          [createdBeforeIso, limit, page * limit],
        )

        if (rows.length === 0)
          break

        apps = [...apps, ...rows.map(row => row.app_id)]
        page++
      }
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting deleted apps from Supabase', error })
    }
    finally {
      await closeClient(c, pgClient)
    }
  }

  return Array.from(new Set(apps))
}

export async function updateOrCreateChannel(
  c: Context,
  update: Database['public']['Tables']['channels']['Insert'],
  existingChannelId: number | null,
  preserveVersion = false,
) {
  cloudlog({ requestId: c.get('requestId'), message: 'updateOrCreateChannel', update })
  if (!update.app_id || !update.name || !update.created_by) {
    cloudlog({ requestId: c.get('requestId'), message: 'missing app_id, name, or created_by' })
    throw new Error('missing app_id, name, or created_by')
  }

  const auth = c.get('auth')
  if (!auth) {
    throw new Error('missing request auth')
  }

  const supabase = supabaseWithAuth(c, auth)
  if (existingChannelId === null) {
    return supabase
      .from('channels')
      .insert(update)
      .select('id')
      .single()
      .throwOnError()
  }

  // Keep the original creator immutable. Omitted stable versions are read only
  // for the response shape and must not overwrite a concurrent promotion.
  const { created_by: _createdBy, version, ...channelUpdate } = update
  const requestUpdate = preserveVersion ? channelUpdate : { ...channelUpdate, version }
  return supabase
    .from('channels')
    .update(requestUpdate)
    .eq('id', existingChannelId)
    .eq('app_id', update.app_id)
    .eq('name', update.name)
    .throwOnError()
}

export async function updateOrCreateChannelDevice(c: Context, update: Database['public']['Tables']['channel_devices']['Insert']) {
  cloudlog({ requestId: c.get('requestId'), message: 'updateOrCreateChannelDevice', update })
  if (!update.device_id || !update.channel_id || !update.app_id) {
    cloudlog({ requestId: c.get('requestId'), message: 'missing device_id, channel_id, or app_id' })
    return Promise.resolve({ error: new Error('missing device_id, channel_id, or app_id') })
  }
  const { data: existingChannelDevice } = await supabaseAdmin(c)
    .from('channel_devices')
    .select('*')
    .eq('device_id', update.device_id)
    .eq('channel_id', update.channel_id)
    .eq('app_id', update.app_id)
    .single()

  if (existingChannelDevice) {
    const fieldsDiffer = Object.keys(update).some(key =>
      (update as any)[key] !== (existingChannelDevice as any)[key] && key !== 'created_at' && key !== 'updated_at',
    )
    if (!fieldsDiffer) {
      cloudlog({ requestId: c.get('requestId'), message: 'No fields differ, no update needed' })
      return Promise.resolve({ error: null })
    }
  }

  return supabaseAdmin(c)
    .from('channel_devices')
    .upsert(update, { onConflict: 'app_id, device_id' })
}

export async function checkAppOwner(c: Context, userId: string | undefined, appId: string | undefined): Promise<boolean> {
  if (!appId || !userId)
    return false
  try {
    const { data, error } = await supabaseAdmin(c)
      .from('apps')
      .select()
      .eq('user_id', userId)
      .eq('app_id', appId)
    if (!data?.length || error)
      return false
    return true
  }
  catch (error) {
    cloudlogErr(error)
    return false
  }
}

export async function apikeyHasOrgRight(c: Context, key: Database['public']['Tables']['apikeys']['Row'], orgId: string) {
  if (!key.rbac_id)
    return false

  const pgClient = getPgClient(c)
  try {
    const result = await pgClient.query<{ allowed: boolean }>(
      `
      SELECT public.rbac_has_permission(
        public.rbac_principal_apikey(),
        $1::uuid,
        public.rbac_perm_org_read(),
        $2::uuid,
        NULL::varchar,
        NULL::bigint
      ) AS allowed
      `,
      [key.rbac_id, orgId],
    )

    return result.rows[0]?.allowed === true
  }
  finally {
    closeClient(c, pgClient)
  }
}

/**
 * Check if API key has org access AND meets org's API key policy requirements
 * Returns { valid: true } if all checks pass, or { valid: false, error: string } if not
 */
export async function apikeyHasOrgRightWithPolicy(
  c: Context,
  key: Database['public']['Tables']['apikeys']['Row'],
  orgId: string,
  supabase: SupabaseClient<Database>,
): Promise<{ valid: boolean, error?: string }> {
  if (!(await apikeyHasOrgRight(c, key, orgId))) {
    return { valid: false, error: 'invalid_org_id' }
  }

  const policyCheck = await checkApikeyMeetsOrgPolicy(c, key, orgId, supabase)
  if (!policyCheck.valid) {
    return policyCheck
  }

  return { valid: true }
}

interface PlanTotal {
  mau: number
  bandwidth: number
  storage: number
  build_time_unit: number
  get: number
  fail: number
  install: number
  uninstall: number
}

export async function getTotalStats(c: Context, orgId?: string): Promise<PlanTotal> {
  if (!orgId) {
    return {
      mau: 0,
      bandwidth: 0,
      storage: 0,
      build_time_unit: 0,
      get: 0,
      fail: 0,
      install: 0,
      uninstall: 0,
    }
  }
  const { data, error } = await supabaseAdmin(c)
    .rpc('get_total_metrics', { org_id: orgId })
    .single()
  if (error)
    throw new Error(error.message)
  return data
}

export interface PlanUsage {
  total_percent: number
  mau_percent: number
  bandwidth_percent: number
  storage_percent: number
  build_time_percent: number
}

export interface PlanUsageAndFit extends PlanUsage {
  is_good_plan: boolean
}

export async function getPlanUsagePercent(c: Context, orgId?: string): Promise<PlanUsage> {
  if (!orgId) {
    return {
      total_percent: 0,
      mau_percent: 0,
      bandwidth_percent: 0,
      storage_percent: 0,
      build_time_percent: 0,
    }
  }
  const { data, error } = await supabaseAdmin(c)
    .rpc('get_plan_usage_percent_detailed', { orgid: orgId })
    .single()
  if (error)
    throw new Error(error.message)
  return data
}

export async function getPlanUsageAndFit(c: Context, orgId: string): Promise<PlanUsageAndFit> {
  // When Stripe isn't configured, still compute usage via Postgres and derive fit from usage.
  // This avoids Stripe API calls while keeping plan enforcement deterministic for tests/on-prem.
  if (!isStripeConfigured(c)) {
    try {
      const { data, error } = await supabaseAdmin(c)
        .rpc('get_plan_usage_and_fit', { orgid: orgId })
        .single()
      if (error)
        throw new Error(error.message)
      return { ...data, is_good_plan: data.total_percent <= 100 }
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getPlanUsageAndFit (no stripe) fallback', orgId, error })
      const percentUsage = await getPlanUsagePercent(c, orgId)
      return { is_good_plan: percentUsage.total_percent <= 100, ...percentUsage }
    }
  }

  try {
    const { data, error } = await supabaseAdmin(c)
      .rpc('get_plan_usage_and_fit', { orgid: orgId })
      .single()
    if (error)
      throw new Error(error.message)
    return data
  }
  catch (error) {
    // Fallback when the RPC is unavailable or fails.
    cloudlogErr({ requestId: c.get('requestId'), message: 'getPlanUsageAndFit fallback', orgId, error })
    const percentUsage = await getPlanUsagePercent(c, orgId)
    return { is_good_plan: percentUsage.total_percent <= 100, ...percentUsage }
  }
}

export async function getPlanUsageAndFitUncached(c: Context, orgId: string): Promise<PlanUsageAndFit> {
  if (!isStripeConfigured(c)) {
    try {
      const { data, error } = await supabaseAdmin(c)
        .rpc('get_plan_usage_and_fit_uncached', { orgid: orgId })
        .single()
      if (error) {
        const message = error.message ?? ''
        const isMissingFunction = message.includes('get_plan_usage_and_fit_uncached')
          || message.includes('schema cache')
        if (isMissingFunction)
          return getPlanUsageAndFit(c, orgId)
        throw new Error(error.message)
      }
      return { ...data, is_good_plan: data.total_percent <= 100 }
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getPlanUsageAndFitUncached (no stripe) fallback', orgId, error })
      const percentUsage = await getPlanUsagePercent(c, orgId)
      return { is_good_plan: percentUsage.total_percent <= 100, ...percentUsage }
    }
  }

  const { data, error } = await supabaseAdmin(c)
    .rpc('get_plan_usage_and_fit_uncached', { orgid: orgId })
    .single()
  if (error) {
    const message = error.message ?? ''
    const isMissingFunction = message.includes('get_plan_usage_and_fit_uncached')
      || message.includes('schema cache')
    if (isMissingFunction) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'getPlanUsageAndFitUncached unavailable, falling back to cached plan usage',
        orgId,
        error,
      })
      return getPlanUsageAndFit(c, orgId)
    }
    // Non-missing-function errors: fall back to percent usage based fit.
    cloudlogErr({ requestId: c.get('requestId'), message: 'getPlanUsageAndFitUncached fallback', orgId, error })
    const percentUsage = await getPlanUsagePercent(c, orgId)
    return { is_good_plan: percentUsage.total_percent <= 100, ...percentUsage }
  }
  return data
}

export async function isGoodPlanOrg(c: Context, orgId: string): Promise<boolean> {
  if (!isStripeConfigured(c)) {
    try {
      const planUsage = await getPlanUsageAndFit(c, orgId)
      return planUsage.total_percent <= 100
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'isGoodPlan (no stripe) fallback', orgId, error })
      return false
    }
  }

  try {
    const { data } = await supabaseAdmin(c)
      .rpc('is_good_plan_v5_org', { orgid: orgId })
      .single()
      .throwOnError()

    // In local/on-prem or misconfigured environments, Stripe isn't available and the
    // RPC may conservatively return false due to missing stripe_info state. Fall back
    // to percent usage derived from the DB in that case.
    if (data === false && !isStripeConfigured(c)) {
      const percentUsage = await getPlanUsagePercent(c, orgId)
      return percentUsage.total_percent <= 100
    }

    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isGoodPlan error', orgId, error })
  }
  // Fallback: derive from percent usage when the RPC is unavailable.
  try {
    const percentUsage = await getPlanUsagePercent(c, orgId)
    return percentUsage.total_percent <= 100
  }
  catch {
    return false
  }
}

export async function isOnboardedOrg(c: Context, orgId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin(c)
      .rpc('is_onboarded_org', { orgid: orgId })
      .single()
      .throwOnError()
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isOnboarded error', orgId, error })
  }
  return false
}

/**
 * Update the MAU exceeded flag for a Stripe customer.
 *
 * Note: `logOrgId` is used for logging/debugging only. The update is scoped by `customerId`.
 */
export async function set_mau_exceeded(c: Context, customerId: string | null, disabled: boolean, logOrgId?: string): Promise<boolean> {
  if (!customerId)
    return true
  // Return the updated row key so we can detect "0 rows affected".
  const { data, error } = await supabaseAdmin(c)
    .from('stripe_info')
    .update({ mau_exceeded: disabled })
    .eq('customer_id', customerId)
    .select('customer_id')
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'set_mau_exceeded error', orgId: logOrgId, customerId, disabled, error })
    return false
  }
  // If no row matched, PostgREST returns an empty array with no error.
  // Treat as failure to avoid silently "succeeding" while not persisting the change.
  // This also protects against accidental mismatched `customerId`.
  if (!data?.length) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'set_mau_exceeded no stripe_info row matched', orgId: logOrgId, customerId, disabled })
    return false
  }
  return true
}

/**
 * Update the storage exceeded flag for a Stripe customer.
 *
 * Note: `logOrgId` is used for logging/debugging only. The update is scoped by `customerId`.
 */
export async function set_storage_exceeded(c: Context, customerId: string | null, disabled: boolean, logOrgId?: string): Promise<boolean> {
  if (!customerId)
    return true
  // Return the updated row key so we can detect "0 rows affected".
  const { data, error } = await supabaseAdmin(c)
    .from('stripe_info')
    .update({ storage_exceeded: disabled })
    .eq('customer_id', customerId)
    .select('customer_id')
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'set_storage_exceeded error', orgId: logOrgId, customerId, disabled, error })
    return false
  }
  if (!data?.length) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'set_storage_exceeded no stripe_info row matched', orgId: logOrgId, customerId, disabled })
    return false
  }
  return true
}

/**
 * Update the bandwidth exceeded flag for a Stripe customer.
 *
 * Note: `logOrgId` is used for logging/debugging only. The update is scoped by `customerId`.
 */
export async function set_bandwidth_exceeded(c: Context, customerId: string | null, disabled: boolean, logOrgId?: string): Promise<boolean> {
  if (!customerId)
    return true
  // Return the updated row key so we can detect "0 rows affected".
  const { data, error } = await supabaseAdmin(c)
    .from('stripe_info')
    .update({ bandwidth_exceeded: disabled })
    .eq('customer_id', customerId)
    .select('customer_id')
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'set_bandwidth_exceeded error', orgId: logOrgId, customerId, disabled, error })
    return false
  }
  if (!data?.length) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'set_bandwidth_exceeded no stripe_info row matched', orgId: logOrgId, customerId, disabled })
    return false
  }
  return true
}

export async function set_build_time_exceeded(c: Context, orgId: string, disabled: boolean): Promise<boolean> {
  const { error } = await supabaseAdmin(c).rpc('set_build_time_exceeded_by_org', { org_id: orgId, disabled })
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'set_build_time_exceeded error', orgId, error })
    return false
  }
  return true
}

export async function recordBuildTime(
  c: Context,
  orgId: string,
  userId: string,
  buildId: string,
  platform: 'ios' | 'android',
  buildTimeSeconds: number,
  completedAt: number | null | undefined,
  appId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin(c)
      .rpc('record_build_time', {
        p_org_id: orgId,
        p_user_id: userId,
        p_build_id: buildId,
        p_platform: platform,
        p_build_time_unit: buildTimeSeconds,
        p_app_id: appId,
      })
      .single()

    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'recordBuildTime error', orgId, userId, buildId, error })
      return null
    }

    if (completedAt) {
      const completedAtIso = new Date(completedAt).toISOString()
      const { error: updateError } = await supabaseAdmin(c)
        .from('build_logs')
        .update({ created_at: completedAtIso })
        .eq('org_id', orgId)
        .eq('build_id', buildId)

      if (updateError) {
        cloudlogErr({
          requestId: c.get('requestId'),
          message: 'recordBuildTime timestamp sync error',
          orgId,
          buildId,
          completedAt: completedAtIso,
          error: updateError,
        })
      }
    }

    return data as string
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'recordBuildTime error', orgId, userId, buildId, error })
    return null
  }
}

export async function getOrgBuildTimeSeconds(
  c: Context,
  orgId: string,
  startDate: string,
  endDate: string,
): Promise<{ total_build_time_unit: number, total_builds: number }> {
  try {
    const { data, error } = await supabaseAdmin(c)
      .rpc('get_org_build_time_unit', {
        p_org_id: orgId,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      .single()

    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getOrgBuildTimeSeconds error', orgId, error })
      return { total_build_time_unit: 0, total_builds: 0 }
    }

    return data as { total_build_time_unit: number, total_builds: number }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getOrgBuildTimeSeconds error', orgId, error })
    return { total_build_time_unit: 0, total_builds: 0 }
  }
}

export async function isOnboardingNeeded(c: Context, userId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin(c)
      .rpc('is_onboarding_needed_org', { orgid: userId })
      .single()
      .throwOnError()
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isOnboardingNeeded error', userId, error })
  }
  return false
}

export async function isCanceledOrg(c: Context, orgId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin(c)
      .rpc('is_canceled_org', { orgid: orgId })
      .single()
      .throwOnError()
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isCanceled error', orgId, error })
  }
  return false
}

export async function isPayingOrg(c: Context, orgId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin(c)
      .rpc('is_paying_org', { orgid: orgId })
      .single()
      .throwOnError()
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isPayingOrg error', orgId, error })
  }
  return false
}

export async function isTrialOrg(c: Context, orgId: string): Promise<number> {
  try {
    const { data } = await supabaseAdmin(c)
      .rpc('is_trial_org', { orgid: orgId })
      .single()
      .throwOnError()
    return data ?? 0
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isTrialOrg error', orgId, error })
  }
  return 0
}

export async function isAllowedActionOrg(c: Context, orgId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin(c)
      .rpc('is_allowed_action_org', { orgid: orgId })
      .single()
      .throwOnError()
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isAllowedActionOrg error', orgId, error })
  }
  return false
}

export async function createApiKey(c: Context, userId: string) {
  if (!userId) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'createApiKey error', userId, error: 'userId is null' })
    return
  }

  const pgClient = getPgClient(c)
  let inTransaction = false
  try {
    await pgClient.query('BEGIN')
    inTransaction = true

    const userLockResult = await pgClient.query(
      'SELECT id FROM auth.users WHERE id = $1::uuid FOR UPDATE',
      [userId],
    )
    if (userLockResult.rowCount === 0) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'createApiKey error', userId, error: 'user not found' })
      await pgClient.query('ROLLBACK')
      return
    }

    const totalResult = await pgClient.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.apikeys WHERE user_id = $1::uuid',
      [userId],
    )
    const total = Number(totalResult.rows[0]?.count ?? '0')
    if (!Number.isFinite(total)) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'createApiKey error', userId, error: 'total is invalid' })
      await pgClient.query('ROLLBACK')
      return
    }
    if (total > 0) {
      await pgClient.query('ROLLBACK')
      return
    }

    const orgResult = await pgClient.query<{ org_id: string }>(
      `SELECT DISTINCT rb.org_id
       FROM public.role_bindings rb
       WHERE rb.principal_type = public.rbac_principal_user()
         AND rb.principal_id = $1::uuid
         AND rb.org_id IS NOT NULL
         AND (rb.expires_at IS NULL OR rb.expires_at > now())

       UNION

       SELECT DISTINCT g.org_id
       FROM public.group_members gm
       INNER JOIN public.groups g ON g.id = gm.group_id
       INNER JOIN public.role_bindings rb
         ON rb.principal_type = public.rbac_principal_group()
         AND rb.principal_id = gm.group_id
         AND rb.org_id = g.org_id
       WHERE gm.user_id = $1::uuid
         AND rb.org_id IS NOT NULL
         AND (rb.expires_at IS NULL OR rb.expires_at > now())`,
      [userId],
    )
    if (orgResult.rows.length === 0) {
      cloudlog({ requestId: c.get('requestId'), message: 'createApiKey skipped, no org membership', userId })
      await pgClient.query('ROLLBACK')
      return
    }

    await pgClient.query(
      `WITH default_keys(name, org_role_name, app_role_name) AS (
         VALUES
           ('default org admin', public.rbac_role_org_admin(), NULL::text),
           ('default app uploader', public.rbac_role_org_member(), public.rbac_role_app_uploader()),
           ('default app reader', public.rbac_role_org_member(), public.rbac_role_app_reader())
       ),
       inserted AS (
         INSERT INTO public.apikeys (
           user_id,
           key,
           key_hash,
           name
         )
         SELECT
           $1::uuid,
           gen_random_uuid()::text,
           NULL,
           default_key.name
         FROM default_keys AS default_key
         RETURNING user_id, rbac_id, name
       ),
       inserted_with_roles AS (
         SELECT
           inserted.user_id,
           inserted.rbac_id,
           inserted.name,
           default_keys.org_role_name,
           default_keys.app_role_name
         FROM inserted
         JOIN default_keys USING (name)
       ),
       current_orgs AS (
         SELECT DISTINCT rb.org_id
         FROM public.role_bindings rb
         WHERE rb.principal_type = public.rbac_principal_user()
           AND rb.principal_id = $1::uuid
           AND rb.org_id IS NOT NULL
           AND (rb.expires_at IS NULL OR rb.expires_at > now())

         UNION

         SELECT DISTINCT g.org_id
         FROM public.group_members gm
         INNER JOIN public.groups g ON g.id = gm.group_id
         INNER JOIN public.role_bindings rb
           ON rb.principal_type = public.rbac_principal_group()
           AND rb.principal_id = gm.group_id
           AND rb.org_id = g.org_id
         WHERE gm.user_id = $1::uuid
           AND rb.org_id IS NOT NULL
           AND (rb.expires_at IS NULL OR rb.expires_at > now())
       ),
       org_bindings AS (
         INSERT INTO public.role_bindings (
           principal_type,
           principal_id,
           role_id,
           scope_type,
           org_id,
           granted_by,
           reason,
           is_direct
         )
         SELECT
           public.rbac_principal_apikey(),
           inserted_with_roles.rbac_id,
           roles.id,
           public.rbac_scope_org(),
           current_orgs.org_id,
           inserted_with_roles.user_id,
           'Default API key RBAC org binding',
           true
         FROM inserted_with_roles
         CROSS JOIN current_orgs
         JOIN public.roles roles
           ON roles.name = inserted_with_roles.org_role_name
         ON CONFLICT DO NOTHING
       )
       INSERT INTO public.role_bindings (
         principal_type,
         principal_id,
         role_id,
         scope_type,
         org_id,
         app_id,
         granted_by,
         reason,
         is_direct
       )
       SELECT
         public.rbac_principal_apikey(),
         inserted_with_roles.rbac_id,
         roles.id,
         public.rbac_scope_app(),
         apps.owner_org,
         apps.id,
         inserted_with_roles.user_id,
         'Default API key RBAC app binding',
         true
       FROM inserted_with_roles
       JOIN current_orgs ON true
       JOIN public.apps apps ON apps.owner_org = current_orgs.org_id
       JOIN public.roles roles
         ON roles.name = inserted_with_roles.app_role_name
       WHERE inserted_with_roles.app_role_name IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [userId],
    )
    await pgClient.query('COMMIT')
  }
  catch (error) {
    if (inTransaction) {
      await pgClient.query('ROLLBACK').catch(() => {})
    }
    cloudlogErr({ requestId: c.get('requestId'), message: 'createApiKey error', userId, error })
  }
  finally {
    closeClient(c, pgClient)
  }
}

export async function customerToSegmentOrg(
  c: Context,
  orgId: string,
  price_id?: string | null,
  plan?: Database['public']['Tables']['plans']['Row'] | null,
  trialPlanNamesToRemove?: readonly string[] | null,
): Promise<{ segments: string[], deleteSegments: string[] }> {
  const segmentsObj = {
    capgo: true,
    onboarded: await isOnboardedOrg(c, orgId),
    trial: false,
    trial7: false,
    trial1: false,
    trial0: false,
    paying: false,
    payingMonthly: plan?.price_m_id === price_id,
    overuse: false,
    canceled: await isCanceledOrg(c, orgId),
    issueSegment: false,
  }

  const trialDaysLeft = await isTrialOrg(c, orgId)
  const paying = await isPayingOrg(c, orgId)
  const canUseMore = await isGoodPlanOrg(c, orgId)
  let billingPlanState: BillingPlanBentoState = 'none'
  if (paying)
    billingPlanState = 'paying'
  else if (trialDaysLeft > 0)
    billingPlanState = 'trial'
  const planTags = buildBillingPlanBentoTags(
    plan?.name,
    billingPlanState,
    trialPlanNamesToRemove,
  )

  if (!segmentsObj.onboarded) {
    const segments = processSegments(segmentsObj)
    return {
      segments: [...segments.segments, ...planTags.segments],
      deleteSegments: [...segments.deleteSegments, ...planTags.deleteSegments],
    }
  }

  if (!paying && trialDaysLeft > 1 && trialDaysLeft <= 7) {
    segmentsObj.trial = true
    segmentsObj.trial7 = true
  }
  else if (!paying && trialDaysLeft === 1) {
    segmentsObj.trial = true
    segmentsObj.trial1 = true
  }
  else if (!paying && !canUseMore) {
    segmentsObj.trial = true
    segmentsObj.trial0 = true
  }
  else if (paying && !canUseMore && plan) {
    segmentsObj.overuse = true
    segmentsObj.paying = true
  }
  else if (paying && canUseMore && plan) {
    segmentsObj.paying = true
  }
  else {
    segmentsObj.issueSegment = true
  }

  const segments = processSegments(segmentsObj)
  return {
    segments: [...segments.segments, ...planTags.segments],
    deleteSegments: [...segments.deleteSegments, ...planTags.deleteSegments],
  }
}

function processSegments(segmentsObj: any): { segments: string[], deleteSegments: string[] } {
  const segments: string[] = []
  const deleteSegments: string[] = []

  Object.entries(segmentsObj).forEach(([key, value]) => {
    if (typeof value === 'boolean') {
      if (value)
        segments.push(key)
      else
        deleteSegments.push(key)
    }
    else if (typeof value === 'string' && value !== '') {
      segments.push(`${key}:${value}`)
    }
  })

  return { segments, deleteSegments }
}

export async function getStripeCustomer(c: Context, customerId: string) {
  const { data: stripeInfo } = await supabaseAdmin(c)
    .from('stripe_info')
    .select('*')
    .eq('customer_id', customerId)
    .single()
  return stripeInfo
}

export async function getDefaultPlan(c: Context) {
  const { data: plan } = await supabaseAdmin(c)
    .from('plans')
    .select()
    .eq('name', 'Solo')
    .single()
  return plan
}


export function trackBandwidthUsageSB(
  c: Context,
  deviceId: string,
  appId: string,
  fileSize: number,
) {
  return supabaseAdmin(c)
    .from('bandwidth_usage')
    .insert([
      {
        device_id: deviceId.toLowerCase(),
        app_id: appId,
        file_size: fileSize,
      },
    ])
}

export function trackVersionUsageSB(
  c: Context,
  versionName: string,
  appId: string,
  action: Database['public']['Enums']['version_action'],
  channel?: VersionUsageChannel | string | null,
) {
  const channelName = typeof channel === 'string' ? channel : channel?.name
  const channelId = typeof channel === 'object' && channel ? channel.id : null
  return supabaseAdmin(c)
    .from('version_usage')
    .insert([
      {
        version_name: versionName,
        app_id: appId,
        action,
        channel_name: channelName ?? null,
        channel_id: channelId ?? null,
      },
    ])
}

export function trackDeviceUsageSB(
  c: Context,
  deviceId: string,
  appId: string,
  orgId: string,
  platform: string,
  versionBuild?: string | null,
) {
  return supabaseAdmin(c)
    .from('device_usage')
    .insert([
      {
        device_id: deviceId.toLowerCase(),
        app_id: appId,
        org_id: orgId,
        platform: platform || 'unknown',
        version_build: versionBuild || 'unknown',
      },
    ])
}

export function trackMetaSB(
  c: Context,
  app_id: string,
  version_id: number,
  size: number,
) {
  cloudlog({ requestId: c.get('requestId'), message: 'createStatsMeta', app_id, version_id, size })
  return supabaseAdmin(c)
    .rpc('upsert_version_meta', {
      p_app_id: app_id,
      p_version_id: version_id,
      p_size: size,
    })
}

export async function trackDevicesSB(c: Context, device: DeviceWithoutCreatedAt) {
  cloudlog({ requestId: c.get('requestId'), message: 'trackDevicesSB', device })

  const client = supabaseAdmin(c)

  const { data: existingRow, error } = await client
    .from('devices')
    .select('version_name, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator, install_source, default_channel, key_id, country_code')
    .eq('app_id', device.app_id)
    .eq('device_id', device.device_id)
    .maybeSingle()

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error fetching existing device', error })
  }

  // Preserve existing custom_id when the client doesn't send one.
  // This avoids accidental clearing, and lets higher-level callers strip custom_id
  // (e.g., when an app disables device self-setting) without overwriting owner-set values.
  const requestedCustomId = nullableString(device.custom_id)
  const requestedInstallSource = nullableString(device.install_source)
  const deviceForWrite: DeviceWithoutCreatedAt = existingRow
    ? {
        ...device,
        ...(requestedCustomId === null ? { custom_id: existingRow.custom_id ?? '' } : {}),
        ...(requestedInstallSource === null ? { install_source: existingRow.install_source ?? undefined } : {}),
      }
    : device

  if (existingRow && !hasComparableDeviceChanged(existingRow, deviceForWrite)) {
    cloudlog({ requestId: c.get('requestId'), message: 'No Supabase upsert needed for device', device_id: device.device_id })
    return Promise.resolve()
  }

  const normalizedDevice = buildNormalizedDeviceForWrite(deviceForWrite)
  const updatedAt = new Date().toISOString()

  const payload = {
    app_id: device.app_id,
    updated_at: updatedAt,
    device_id: device.device_id,
    platform: normalizedDevice.platform ?? deviceForWrite.platform,
    plugin_version: normalizedDevice.plugin_version ?? undefined,
    os_version: normalizedDevice.os_version ?? undefined,
    version_build: normalizedDevice.version_build ?? undefined,
    // Only persist custom_id if the client explicitly sent one.
    custom_id: requestedCustomId ?? undefined,
    version_name: normalizedDevice.version_name ?? deviceForWrite.version_name,
    is_prod: normalizedDevice.is_prod,
    is_emulator: normalizedDevice.is_emulator,
    ...(requestedInstallSource === null ? {} : { install_source: normalizedDevice.install_source ?? undefined }),
    default_channel: device.default_channel ?? null,
    key_id: normalizedDevice.key_id ?? undefined,
    country_code: normalizedDevice.country_code ?? undefined,
  } as Database['public']['Tables']['devices']['Insert']

  return client
    .from('devices')
    .upsert(payload, { onConflict: 'device_id,app_id' })
}

export function trackLogsSB(c: Context, app_id: string, device_id: string, action: Database['public']['Enums']['stats_action'], version_name: string, metadata?: StatsMetadata) {
  return supabaseAdmin(c)
    .from('stats')
    .insert(
      {
        app_id,
        created_at: new Date().toISOString(),
        device_id,
        action,
        version_name,
        metadata,
      },
    )
}

export async function readDeviceUsageSB(c: Context, app_id: string, period_start: string, period_end: string) {
  const { data } = await supabaseAdmin(c)
    .rpc('read_device_usage', { p_app_id: app_id, p_period_start: period_start, p_period_end: period_end })
  return data ?? []
}

export async function readBandwidthUsageSB(c: Context, app_id: string, period_start: string, period_end: string) {
  const { data } = await supabaseAdmin(c)
    .rpc('read_bandwidth_usage', { p_app_id: app_id, p_period_start: period_start, p_period_end: period_end })
  return data ?? []
}

export async function readStatsStorageSB(c: Context, app_id: string, period_start: string, period_end: string) {
  const { data } = await supabaseAdmin(c)
    .rpc('read_storage_usage', { p_app_id: app_id, p_period_start: period_start, p_period_end: period_end })
  return data ?? []
}

export async function readStatsVersionSB(c: Context, app_id: string, period_start: string, period_end: string, channel?: VersionUsageChannel | string): Promise<VersionUsage[]> {
  const channelId = typeof channel === 'object' && channel ? channel.id : null
  const channelName = typeof channel === 'string' ? channel : channelId ? null : channel?.name
  const args = {
    p_app_id: app_id,
    p_period_start: period_start,
    p_period_end: period_end,
    ...(channelName ? { p_channel_name: channelName } : {}),
    ...(channelId ? { p_channel_id: channelId } : {}),
  }
  const { data } = await supabaseAdmin(c)
    .rpc('read_version_usage', args)
  // Cast to VersionUsage[] - the SQL function returns version_name but auto-generated types are stale
  return (data ?? []) as unknown as VersionUsage[]
}

export async function readNativeVersionUsageSB(c: Context, app_id: string, period_start: string, period_end: string, supabase: SupabaseClient<Database>): Promise<NativeVersionUsage[]> {
  const { data, error } = await supabase
    .rpc('read_native_version_usage' as any, { p_app_id: app_id, p_period_start: period_start, p_period_end: period_end })

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading native version usage', error })
    throw error
  }

  return (data ?? []) as unknown as NativeVersionUsage[]
}

export async function readDeviceVersionCountsSB(c: Context, app_id: string, channelName?: string): Promise<Record<string, number>> {
  let query = supabaseAdmin(c)
    .from('devices')
    .select('version_name')
    .eq('app_id', app_id)

  if (channelName) {
    query = query.eq('default_channel', channelName)
  }

  const { data, error } = await query
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device version counts', error })
    return {}
  }

  return (data ?? []).reduce<Record<string, number>>((acc, row) => {
    const version = row.version_name || 'unknown'
    acc[version] = (acc[version] || 0) + 1
    return acc
  }, {})
}

/**
 * Retrieve stats entries for the given app, honoring the optional filters and sorting provided in `params`.
 */
export async function readStatsSB(c: Context, params: ReadStatsParams) {
  const supabase = supabaseAdmin(c)

  let query = supabase
    .from('stats')
    .select('*')
    .eq('app_id', params.app_id)
    .limit(params.limit ?? DEFAULT_LIMIT)

  if (params.start_date)
    query = query.gte('created_at', new Date(params.start_date).toISOString())

  if (params.end_date)
    query = query.lt('created_at', new Date(params.end_date).toISOString())

  if (params.deviceIds?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'deviceIds', deviceIds: params.deviceIds })
    if (params.deviceIds.length === 1)
      query = query.eq('device_id', params.deviceIds[0])
    else
      query = query.in('device_id', params.deviceIds)
  }

  if (params.actions?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'actions filter', actions: params.actions })
    if (params.actions.length === 1)
      query = query.eq('action', params.actions[0] as Database['public']['Enums']['stats_action'])
    else
      query = query.in('action', params.actions as Database['public']['Enums']['stats_action'][])
  }

  if (params.search) {
    cloudlog({ requestId: c.get('requestId'), message: 'search', search: params.search })
    const searchPattern = buildIlikeContainsPattern(params.search)
    const orFilters = params.deviceIds?.length
      ? [`version_name.ilike.${searchPattern}`]
      : [`device_id.ilike.${searchPattern}`, `version_name.ilike.${searchPattern}`]

    const matchedActions = Constants.public.Enums.stats_action
      .filter(action => action.toLowerCase().includes(params.search!.toLowerCase()))
      .map(action => `action.eq.${action}`)

    query = query.or([...orFilters, ...matchedActions].join(','))
  }

  if (params.order?.length) {
    params.order.forEach((col: Order) => {
      if (col.sortable && typeof col.sortable === 'string') {
        cloudlog({ requestId: c.get('requestId'), message: 'order', key: col.key, sortable: col.sortable })
        query = query.order(col.key as string, { ascending: col.sortable === 'asc' })
      }
    })
  }

  const { data, error } = await query

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading stats list', error })
    return []
  }

  return data ?? []
}

export async function readStatsInsightsSB(c: Context, params: ReadStatsInsightsParams): Promise<StatsInsightsResult> {
  const pgClient = getPgClient(c)
  const actionValues = params.actions?.length ? params.actions : []
  const actionFilter = actionValues.length > 0 ? 'AND action = ANY($4::public.stats_action[])' : ''
  const values = actionValues.length > 0
    ? [params.app_id, params.start_date, params.end_date, actionValues]
    : [params.app_id, params.start_date, params.end_date]

  try {
    const summaryQuery = `
      SELECT
        COUNT(*)::text AS total,
        COUNT(DISTINCT device_id)::text AS device_count,
        COUNT(DISTINCT action)::text AS action_count
      FROM public.stats
      WHERE app_id = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
        ${actionFilter}
    `

    const actionsQuery = `
      SELECT
        action::text AS action,
        COUNT(*)::text AS total,
        COUNT(DISTINCT device_id)::text AS device_count,
        COUNT(DISTINCT version_name)::text AS version_count,
        MIN(created_at)::text AS first_seen,
        MAX(created_at)::text AS last_seen,
        COALESCE((ARRAY_AGG(version_name ORDER BY created_at DESC))[1], 'unknown') AS latest_version_name,
        COALESCE((ARRAY_AGG(device_id ORDER BY created_at DESC))[1], '') AS latest_device_id
      FROM public.stats
      WHERE app_id = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
        ${actionFilter}
      GROUP BY action
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `

    const dailyQuery = `
      SELECT
        TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        action::text AS action,
        COUNT(*)::text AS total
      FROM public.stats
      WHERE app_id = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
        ${actionFilter}
      GROUP BY 1, 2
      ORDER BY 1 ASC, COUNT(*) DESC
    `

    const versionsQuery = `
      SELECT
        action::text AS action,
        COALESCE(NULLIF(version_name, ''), 'unknown') AS version_name,
        COUNT(*)::text AS total,
        COUNT(DISTINCT device_id)::text AS device_count,
        MAX(created_at)::text AS last_seen
      FROM public.stats
      WHERE app_id = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
        ${actionFilter}
      GROUP BY action, COALESCE(NULLIF(version_name, ''), 'unknown')
      ORDER BY COUNT(*) DESC
      LIMIT 30
    `

    const devicesQuery = `
      SELECT
        action::text AS action,
        device_id,
        COUNT(*)::text AS total,
        COALESCE((ARRAY_AGG(version_name ORDER BY created_at DESC))[1], 'unknown') AS version_name,
        MAX(created_at)::text AS last_seen
      FROM public.stats
      WHERE app_id = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
        ${actionFilter}
      GROUP BY action, device_id
      ORDER BY COUNT(*) DESC
      LIMIT 30
    `

    const [summaryResult, actionsResult, dailyResult, versionsResult, devicesResult] = await Promise.all([
      pgClient.query(summaryQuery, values),
      pgClient.query(actionsQuery, values),
      pgClient.query(dailyQuery, values),
      pgClient.query(versionsQuery, values),
      pgClient.query(devicesQuery, values),
    ])

    return normalizeStatsInsightsResult({
      summary: summaryResult.rows[0],
      actions: actionsResult.rows,
      daily: dailyResult.rows,
      versions: versionsResult.rows,
      devices: devicesResult.rows,
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading stats insights from Supabase', error })
    return emptyStatsInsights()
  }
  finally {
    closeClient(c, pgClient)
  }
}

/**
 * Query the devices table for an app with search, cursor pagination, and ordering helpers applied.
 */
export async function readDevicesSB(c: Context, params: ReadDevicesParams, customIdMode: boolean) {
  const supabase = supabaseAdmin(c)
  const limit = params.limit ?? DEFAULT_LIMIT

  cloudlog({ requestId: c.get('requestId'), message: 'readDevicesSB', params })

  let query = supabase
    .from('devices')
    .select('*')
    .eq('app_id', params.app_id)

  if (customIdMode) {
    query = query
      .not('custom_id', 'is', null)
      .neq('custom_id', '')
  }

  if (params.deviceIds?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'deviceIds', deviceIds: params.deviceIds })
    if (params.deviceIds.length === 1)
      query = query.eq('device_id', params.deviceIds[0])
    else
      query = query.in('device_id', params.deviceIds)
  }

  if (params.search) {
    cloudlog({ requestId: c.get('requestId'), message: 'search', search: params.search })
    const searchPattern = buildIlikeContainsPattern(params.search)
    if (params.deviceIds?.length)
      query = query.or(`custom_id.ilike.${searchPattern},version_name.ilike.${searchPattern}`)
    else
      query = query.or(`device_id.ilike.${searchPattern},custom_id.ilike.${searchPattern},version_name.ilike.${searchPattern}`)
  }

  if (params.version_name)
    query = query.eq('version_name', params.version_name)

  if (params.installSources?.length)
    query = query.in('install_source', params.installSources)

  if (params.updated_at_gt)
    query = query.gt('updated_at', params.updated_at_gt)

  const devicesOrder = getDevicesOrder(params.order)

  if (params.cursor) {
    // Cursor format: "updated_at|device_id"
    const [cursorTime, cursorDeviceId] = params.cursor.split('|')
    if (cursorTime && cursorDeviceId) {
      const quotedCursorTime = quotePostgrestFilterValue(cursorTime)
      const quotedCursorDeviceId = quotePostgrestFilterValue(cursorDeviceId)
      if (!devicesOrder)
        query = query.gt('device_id', cursorDeviceId)
      else if (devicesOrder.ascending)
        query = query.or(`updated_at.gt.${quotedCursorTime},and(updated_at.eq.${quotedCursorTime},device_id.gt.${quotedCursorDeviceId})`)
      else
        query = query.or(`updated_at.lt.${quotedCursorTime},and(updated_at.eq.${quotedCursorTime},device_id.gt.${quotedCursorDeviceId})`)
    }
  }

  if (devicesOrder)
    query = query.order('updated_at', { ascending: devicesOrder.ascending })
  query = query.order('device_id', { ascending: true })
    .limit(limit + 1) // Fetch one extra to check if there are more results

  const { data, error } = await query

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device list', error })
    return []
  }

  return data ?? []
}

export async function countInstallSourcesSB(c: Context, app_id: string): Promise<Record<string, number>> {
  const pgClient = await getPgClient(c)
  try {
    const result = await pgClient.query<{ install_source: string, total: string }>(`
      SELECT install_source, COUNT(*)::text AS total
      FROM public.devices
      WHERE app_id = $1
        AND install_source IS NOT NULL
        AND install_source != ''
      GROUP BY install_source
    `, [app_id])

    return result.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.install_source] = Number(row.total)
      return acc
    }, {})
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error counting install sources', error })
    return {}
  }
  finally {
    closeClient(c, pgClient)
  }
}

/**
 * Count how many devices match the supplied filters so pagination totals stay accurate.
 */
export async function countDevicesSB(
  c: Context,
  app_id: string,
  customIdMode: boolean,
  deviceIds: string[] = [],
  versionName?: string,
  search?: string,
) {
  let req = supabaseAdmin(c)
    .from('devices')
    .select('device_id', { count: 'exact', head: true })
    .eq('app_id', app_id)

  if (customIdMode) {
    req = req
      .not('custom_id', 'is', null)
      .neq('custom_id', '')
  }

  if (deviceIds.length) {
    if (deviceIds.length === 1)
      req = req.eq('device_id', deviceIds[0])
    else
      req = req.in('device_id', deviceIds)
  }

  if (search) {
    const normalizedSearch = buildIlikeContainsPattern(search)
    if (deviceIds.length)
      req = req.or(`custom_id.ilike.${normalizedSearch},version_name.ilike.${normalizedSearch}`)
    else
      req = req.or(`device_id.ilike.${normalizedSearch},custom_id.ilike.${normalizedSearch},version_name.ilike.${normalizedSearch}`)
  }

  if (versionName)
    req = req.eq('version_name', versionName)

  const { count, error } = await req

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error counting devices', error })
    return 0
  }
  return count ?? 0
}

const DEFAULT_PLAN_NAME = 'Solo'

export async function getCurrentPlanNameOrg(c: Context, orgId?: string): Promise<string> {
  if (!orgId)
    return DEFAULT_PLAN_NAME
  const { data, error } = await supabaseAdmin(c)
    .rpc('get_current_plan_name_org', { orgid: orgId })
    .single()
  if (error)
    throw new Error(error.message)

  return data ?? DEFAULT_PLAN_NAME
}

interface UpdateStats {
  apps: {
    app_id: string
    failed: number
    set: number
    get: number
    success_rate: number
    healthy: boolean
  }[]
  total: {
    failed: number
    set: number
    get: number
    success_rate: number
    healthy: boolean
  }
}

export async function getUpdateStatsSB(c: Context): Promise<UpdateStats> {
  const { data, error } = await supabaseAdmin(c)
    .rpc('get_update_stats')

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting update stats', error })
    return {
      apps: [],
      total: {
        failed: 0,
        set: 0,
        get: 0,
        success_rate: 100,
        healthy: true,
      },
    }
  }

  const apps = data.map((app: any) => {
    const totalEvents = app.failed + app.install + app.get
    const successRate = Number((totalEvents > 0 ? ((app.install + app.get) / totalEvents) * 100 : 100).toFixed(2))
    return {
      app_id: app.app_id,
      failed: Number(app.failed),
      set: Number(app.install),
      get: Number(app.get),
      success_rate: successRate,
      healthy: successRate >= 70,
    }
  })

  const total = apps.reduce((acc, app) => {
    acc.failed += app.failed
    acc.set += app.set
    acc.get += app.get
    return acc
  }, { failed: 0, set: 0, get: 0 })

  const totalEvents = total.failed + total.set + total.get
  const totalSuccessRate = totalEvents > 0 ? ((total.set + total.get) / totalEvents) * 100 : 100

  return {
    apps,
    total: {
      ...total,
      success_rate: Number(totalSuccessRate.toFixed(2)),
      healthy: totalSuccessRate >= 70,
    },
  }
}

/**
 * Check API key by key string
 * Uses find_apikey_by_value SQL function to look up both plain-text and hashed keys
 * Expiration is checked after lookup
 */
export async function checkKey(c: Context, authorization: string | undefined, supabase: SupabaseClient<Database>): Promise<Database['public']['Tables']['apikeys']['Row'] | null> {
  if (!authorization)
    return null

  try {
    // Use find_apikey_by_value SQL function to look up both plain-text and hashed keys
    // RPC calls use parameterized queries, so SQL injection is not possible
    const { data, error } = await supabase
      .rpc('find_apikey_by_value', { key_value: authorization })
      .single()

    if (error || !data) {
      cloudlog({ requestId: c.get('requestId'), message: 'Invalid apikey', authorizationPrefix: authorization?.substring(0, 8), error })
      return null
    }

    // Check if key is expired
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      cloudlog({ requestId: c.get('requestId'), message: 'Apikey expired', authorizationPrefix: authorization?.substring(0, 8) })
      return null
    }

    return data
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'checkKey error', error })
    return null
  }
}

/**
 * Check API key by ID
 * Expiration is checked directly in SQL query: expires_at IS NULL OR expires_at > now()
 */
export async function checkKeyById(
  c: Context,
  id: number,
  supabase: SupabaseClient<Database>,
  userId?: string,
): Promise<Database['public']['Tables']['apikeys']['Row'] | null> {
  if (!id)
    return null
  try {
    // Expiration check is done in SQL: expires_at IS NULL OR expires_at > now()
    let query = supabase
      .from('apikeys')
      .select('*')
      .eq('id', id)
      .or('expires_at.is.null,expires_at.gt.now()')
    if (userId) {
      query = query.eq('user_id', userId)
    }
    const { data, error } = await query.single()
    if (!data || error)
      return null
    return data
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'checkKeyById error', error })
    return null
  }
}

/**
 * Validate expiration date format and that it's in the future.
 * Throws simpleError if validation fails.
 * @param expiresAt - The expiration date string (can be null/undefined to skip validation)
 */
export function validateExpirationDate(expiresAt: string | null | undefined): void {
  if (expiresAt === null || expiresAt === undefined) {
    return
  }
  const expirationDate = new Date(expiresAt)
  if (Number.isNaN(expirationDate.getTime())) {
    throw simpleError('invalid_expiration_date', 'Invalid expiration date format')
  }
  if (expirationDate <= new Date()) {
    throw simpleError('invalid_expiration_date', 'Expiration date must be in the future')
  }
}

/**
 * Resolve all organization IDs affected by API key scopes.
 * App-scoped keys inherit expiration policy from the app owner organization.
 */
export async function resolveApikeyPolicyOrgIds(
  supabase: SupabaseClient<Database>,
  options: {
    limitedToApps?: string[] | null
    limitedToOrgs?: string[] | null
    policyLookupSupabase?: SupabaseClient<Database>
  },
): Promise<string[]> {
  const orgIds = new Set((options.limitedToOrgs ?? []).filter(Boolean))
  const limitedToApps = [...new Set((options.limitedToApps ?? []).filter(Boolean))]

  if (limitedToApps.length === 0) {
    return [...orgIds]
  }

  const resolvedAppIds = new Set<string>()

  async function addResolvedApps(client: SupabaseClient<Database>, appIds: string[]) {
    if (appIds.length === 0) {
      return
    }

    const { data: apps, error } = await client
      .from('apps')
      .select('app_id, owner_org')
      .in('app_id', appIds)

    if (error) {
      throw simpleError('failed_to_resolve_apikey_policy_scope', 'Failed to resolve API key policy scope', { supabaseError: error })
    }

    for (const app of apps ?? []) {
      if (!app.app_id || !app.owner_org)
        continue
      resolvedAppIds.add(app.app_id)
      orgIds.add(app.owner_org)
    }
  }

  await addResolvedApps(supabase, limitedToApps)

  let unresolvedAppIds = limitedToApps.filter(appId => !resolvedAppIds.has(appId))
  if (unresolvedAppIds.length > 0 && options.policyLookupSupabase) {
    // Hidden apps still need owner-org policy enforcement even when caller RLS cannot see them.
    await addResolvedApps(options.policyLookupSupabase, unresolvedAppIds)
    unresolvedAppIds = unresolvedAppIds.filter(appId => !resolvedAppIds.has(appId))
  }

  if (unresolvedAppIds.length > 0) {
    throw simpleError('failed_to_resolve_apikey_policy_scope', 'Failed to resolve API key policy scope', { unresolvedAppIds })
  }

  return [...orgIds]
}

/**
 * Validate API key expiration against org policies for multiple orgs.
 * Throws simpleError if any org policy is violated.
 * @param orgIds - Array of org IDs to validate against
 * @param expiresAt - The expiration date string
 * @param supabase - Supabase client
 */
export async function validateExpirationAgainstOrgPolicies(
  orgIds: string[],
  expiresAt: string | null,
  supabase: SupabaseClient<Database>,
): Promise<void> {
  if (orgIds.length === 0) {
    return
  }

  // Fetch all org policies in a single query
  const { data: orgs } = await supabase
    .from('orgs')
    .select('id, require_apikey_expiration, max_apikey_expiration_days')
    .in('id', orgIds)

  if (!orgs || orgs.length === 0) {
    return
  }

  for (const org of orgs) {
    // Check if expiration is required but not provided
    if (org.require_apikey_expiration && !expiresAt) {
      throw simpleError('expiration_required', 'This organization requires API keys to have an expiration date')
    }

    // Check if expiration exceeds max allowed
    if (org.max_apikey_expiration_days && expiresAt) {
      const maxDate = new Date()
      maxDate.setDate(maxDate.getDate() + org.max_apikey_expiration_days)
      if (new Date(expiresAt) > maxDate) {
        throw simpleError('expiration_exceeds_max', `API key expiration cannot exceed ${org.max_apikey_expiration_days} days for this organization`)
      }
    }
  }
}

/**
 * Check if an API key meets org policy at usage time
 */
export async function checkApikeyMeetsOrgPolicy(
  c: Context,
  key: Database['public']['Tables']['apikeys']['Row'],
  orgId: string,
  supabase: SupabaseClient<Database>,
): Promise<{ valid: boolean, error?: string }> {
  const { data: org, error } = await supabase
    .from('orgs')
    .select('require_apikey_expiration')
    .eq('id', orgId)
    .single()

  if (error || !org) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'checkApikeyMeetsOrgPolicy: unable to load org policy',
      error,
      orgId,
    })
    return { valid: false, error: 'org_policy_lookup_failed' }
  }

  if (org.require_apikey_expiration && !key.expires_at) {
    return { valid: false, error: 'org_requires_expiring_key' }
  }

  return { valid: true }
}

/**
 * Check if an API key is valid for a specific organization based on its hashed key enforcement setting.
 * Returns true if the key can access the org, false if the org requires hashed keys and this is a plain-text key.
 */
export async function checkKeyOrgEnforcement(
  c: Context,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  orgId: string,
  supabase: SupabaseClient<Database>,
): Promise<boolean> {
  try {
    // Check if org enforces hashed keys
    const { data: org, error } = await supabase
      .from('orgs')
      .select('enforce_hashed_api_keys')
      .eq('id', orgId)
      .single()

    if (error || !org) {
      // Org not found or error - allow (will fail on other checks)
      return true
    }

    if (!org.enforce_hashed_api_keys) {
      // Org doesn't enforce hashed keys
      return true
    }

    // Org enforces hashed keys - check if this is a hashed key
    // A hashed key has key_hash set and key is null
    const isHashedKey = apikey.key_hash !== null && apikey.key === null
    if (!isHashedKey) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Org enforces hashed keys but key is plain-text',
        orgId,
        apikeyId: apikey.id,
      })
      return false
    }
    return true
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'checkKeyOrgEnforcement error', error })
    return true // Allow on error - will fail on other checks
  }
}
