import type { Context } from 'hono'
// @ts-types="npm:@types/pg"
import type { BillingPlanBentoState } from './billing_bento_tags.ts'
import type { AuthInfo } from './hono.ts'
import type { PgClient, PgQueryClient } from './pg.ts'
import type { RlsPrincipal } from './pg_rls.ts'
import type { Database } from './supabase.types.ts'
import type { ChannelDeviceOverrideIds, ChannelDevicePlatform, DeviceWithoutCreatedAt, NativeActiveDevicesByPlatformRow, NativeVersionUsage, Order, ReadDevicesParams, ReadStatsInsightsParams, ReadStatsParams, StatsInsightsResult, StatsMetadata, VersionUsage, VersionUsageChannel } from './types.ts'
import { createClient } from '@supabase/supabase-js'
import { HTTPException } from 'hono/http-exception'
import { applyDirectOfferBentoTags, buildBillingPlanBentoTags } from './billing_bento_tags.ts'
import { buildNormalizedDeviceForWrite, hasComparableDeviceChanged, nullableString } from './deviceComparison.ts'
import { CREATE_DEFAULT_API_KEYS_SQL } from './default_apikeys.ts'
import { getDirectOfferStatus } from './direct_offer.ts'
import { quickError, simpleError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { beginWriteTransaction, checkoutPgClient, closeClient, getPgClient, releasePgClient } from './pg.ts'
import { isTransientPgError } from './pg_errors.ts'
import { authPrincipal, queryJson, queryJsonOne, withRlsContext } from './pg_rls.ts'
import { getPlanPriceInterval } from './plan_price_interval.ts'
import { getClientIP } from './rate_limit.ts'
import { emptyStatsInsights, normalizeStatsInsightsResult } from './statsInsights.ts'
import { Constants } from './supabase.types.ts'
import { getEnv, isStripeConfigured } from './utils.ts'
import { buildVersionCompareSql } from './versionCompare.ts'

const DEFAULT_LIMIT = 1000

/** Runs `run` on a service-role (RLS-bypassing) connection, like the old `supabaseAdmin(c)` calls. */
async function withAdminPg<T>(c: Context, run: (pg: PgClient) => Promise<T>): Promise<T> {
  const pg = await getPgClient(c)
  try {
    return await run(pg)
  }
  finally {
    closeClient(c, pg)
  }
}

const SQL_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

/** Quotes a column name. Column names here come from typed rows, never from SQL text built from user input. */
function quoteIdent(name: string): string {
  if (!SQL_IDENTIFIER_RE.test(name))
    throw new Error(`Invalid column name: ${name}`)
  return `"${name}"`
}

/** Columns of `row` that PostgREST would have sent: JSON drops `undefined` values. */
function definedColumns(row: object): { columns: string[], values: unknown[] } {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined)
  return { columns: entries.map(([key]) => quoteIdent(key)), values: entries.map(([, value]) => value) }
}

/** `INSERT INTO table (...) VALUES (...)` for the defined columns of `row`, with placeholders starting at $1. */
function buildInsertSql(table: string, row: object): { text: string, columns: string[], values: unknown[] } {
  const { columns, values } = definedColumns(row)
  const placeholders = values.map((_, index) => `$${index + 1}`)
  return { text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, columns, values }
}

/** PostgREST upsert (`merge-duplicates`): insert, or overwrite the provided columns on conflict. */
function buildUpsertSql(table: string, row: object, conflictColumns: string[]): { text: string, values: unknown[] } {
  const insert = buildInsertSql(table, row)
  const updates = insert.columns.map(column => `${column} = EXCLUDED.${column}`)
  return {
    text: `${insert.text} ON CONFLICT (${conflictColumns.map(quoteIdent).join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
    values: insert.values,
  }
}

/** Inserts `row` as service role and resolves `{ error }` instead of throwing, like the supabase-js builder did. */
async function insertAdminRow(c: Context, table: string, row: object, logMessage: string): Promise<{ error: unknown | null }> {
  try {
    const { text, values } = buildInsertSql(table, row)
    await withAdminPg(c, pg => pg.query(text, values))
    return { error: null }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: logMessage, error })
    return { error }
  }
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

function hasDeviceVersionCompare(params: Pick<ReadDevicesParams, 'os_version_compare' | 'version_name_compare'>) {
  return Boolean(params.os_version_compare || params.version_name_compare)
}

function buildDevicesSqlWhere(params: ReadDevicesParams, customIdMode: boolean) {
  const values: unknown[] = [params.app_id]
  const clauses = ['app_id = $1']

  if (customIdMode)
    clauses.push(`custom_id IS NOT NULL AND custom_id != ''`)

  if (params.deviceIds?.length) {
    values.push(params.deviceIds)
    clauses.push(`device_id = ANY($${values.length}::text[])`)
  }

  if (params.customIds?.length) {
    values.push(params.customIds)
    clauses.push(`custom_id = ANY($${values.length}::text[])`)
  }

  if (params.search) {
    values.push(`%${params.search}%`)
    const searchIndex = values.length
    if (params.deviceIds?.length)
      clauses.push(`(custom_id ILIKE $${searchIndex} OR version_name ILIKE $${searchIndex})`)
    else
      clauses.push(`(device_id ILIKE $${searchIndex} OR custom_id ILIKE $${searchIndex} OR version_name ILIKE $${searchIndex})`)
  }

  if (params.version_name_compare) {
    clauses.push(buildVersionCompareSql('version_name', params.version_name_compare, 'pg'))
  }
  else if (params.version_name) {
    const versionNames = (Array.isArray(params.version_name) ? params.version_name : [params.version_name])
      .map(name => name.trim())
      .filter(Boolean)
    if (versionNames.length === 1) {
      values.push(versionNames[0])
      clauses.push(`version_name = $${values.length}`)
    }
    else if (versionNames.length > 1) {
      values.push(versionNames)
      clauses.push(`version_name = ANY($${values.length}::text[])`)
    }
  }

  if (params.os_version_compare)
    clauses.push(buildVersionCompareSql('os_version', params.os_version_compare, 'pg'))

  if (params.platform) {
    values.push(params.platform)
    clauses.push(`platform = $${values.length}::public.platform_os`)
  }

  if (params.default_channel) {
    values.push(params.default_channel)
    clauses.push(`default_channel = $${values.length}`)
  }

  if (params.installSources?.length) {
    values.push(params.installSources)
    clauses.push(`install_source = ANY($${values.length}::text[])`)
  }

  if (params.updated_at_gt) {
    values.push(params.updated_at_gt)
    clauses.push(`updated_at > $${values.length}::timestamptz`)
  }
  if (params.updated_at_lte) {
    values.push(params.updated_at_lte)
    clauses.push(`updated_at <= $${values.length}::timestamptz`)
  }

  const devicesOrder = getDevicesOrder(params.order)
  if (params.cursor) {
    const [cursorTime, cursorDeviceId] = params.cursor.split('|')
    if (cursorTime && cursorDeviceId) {
      if (!devicesOrder) {
        values.push(cursorDeviceId)
        clauses.push(`device_id > $${values.length}`)
      }
      else {
        values.push(cursorTime, cursorDeviceId)
        const timeIndex = values.length - 1
        const idIndex = values.length
        const cmp = devicesOrder.ascending ? '>' : '<'
        clauses.push(`(updated_at ${cmp} $${timeIndex}::timestamptz OR (updated_at = $${timeIndex}::timestamptz AND device_id > $${idIndex}))`)
      }
    }
  }

  return { values, where: clauses.join(' AND '), devicesOrder }
}

// Version-compare filters always read from the replica; plain filters keep the primary reads PostgREST did.
async function readDevicesSBSql(c: Context, params: ReadDevicesParams, customIdMode: boolean) {
  const versionCompare = hasDeviceVersionCompare(params)
  const limit = params.limit ?? DEFAULT_LIMIT
  const { values, where, devicesOrder } = buildDevicesSqlWhere(params, customIdMode)
  const orderBy = devicesOrder
    ? `updated_at ${devicesOrder.ascending ? 'ASC' : 'DESC'}, device_id ASC`
    : 'device_id ASC'
  values.push(limit + 1)
  const pgClient = await getPgClient(c, versionCompare)
  try {
    return await queryJson<Database['public']['Tables']['devices']['Row']>(
      pgClient,
      `SELECT * FROM public.devices WHERE ${where} ORDER BY ${orderBy} LIMIT $${values.length}`,
      values,
    )
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: versionCompare ? 'Error reading device list with version compare' : 'Error reading device list', error })
    return []
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function countDevicesSBSql(
  c: Context,
  app_id: string,
  customIdMode: boolean,
  deviceIds: string[],
  versionName: string | string[] | undefined,
  search: string | undefined,
  options?: {
    platform?: Database['public']['Enums']['platform_os']
    defaultChannel?: string
    updatedAt?: { gt?: string, lte?: string }
    osVersionCompare?: ReadDevicesParams['os_version_compare']
    versionNameCompare?: ReadDevicesParams['version_name_compare']
  },
) {
  const { values, where } = buildDevicesSqlWhere({
    app_id,
    deviceIds,
    version_name: versionName,
    search,
    platform: options?.platform,
    default_channel: options?.defaultChannel,
    updated_at_gt: options?.updatedAt?.gt,
    updated_at_lte: options?.updatedAt?.lte,
    os_version_compare: options?.osVersionCompare,
    version_name_compare: options?.versionNameCompare,
  }, customIdMode)
  const versionCompare = Boolean(options?.osVersionCompare || options?.versionNameCompare)
  const pgClient = await getPgClient(c, versionCompare)
  try {
    const result = await pgClient.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM public.devices WHERE ${where}`,
      values,
    )
    return Number(result.rows[0]?.total ?? 0)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: versionCompare ? 'Error counting devices with version compare' : 'Error counting devices', error })
    return 0
  }
  finally {
    closeClient(c, pgClient)
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

/** Anon GoTrue client that forwards the trusted client IP for auth rate limiting. */
export function emptySupabaseWithClientIP(c: Context) {
  const clientIp = getClientIP(c)
  const options = {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    ...(clientIp !== 'unknown'
      ? { global: { headers: { 'X-Forwarded-For': clientIp } } }
      : {}),
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
  let apps: string[] = []
  const pgClient = await getPgClient(c, false)

  try {
    try {
      const { rows } = createdBeforeIso
        ? await pgClient.query<{ app_id: string }>('SELECT app_id FROM public.apps WHERE created_at < $1::timestamptz', [createdBeforeIso])
        : await pgClient.query<{ app_id: string }>('SELECT app_id FROM public.apps')
      apps = rows.map(row => row.app_id)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting apps from Supabase', error })
    }

    if (createdBeforeIso) {
      try {
        let page = 0
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
    }
  }
  finally {
    closeClient(c, pgClient)
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

  const principal = authPrincipal(c, auth)
  if (existingChannelId === null) {
    const insert = buildInsertSql('public.channels', update)
    const data = await withRlsContext(c, principal, client => queryJsonOne<{ id: number }>(client, `${insert.text} RETURNING id`, insert.values))
    if (!data)
      throw new Error('JSON object requested, multiple (or no) rows returned')
    return { data, error: null }
  }

  // Keep the original creator immutable. Omitted stable versions are read only
  // for the response shape and must not overwrite a concurrent promotion.
  const { created_by: _createdBy, version, ...channelUpdate } = update
  const requestUpdate = preserveVersion ? channelUpdate : { ...channelUpdate, version }
  const { columns, values } = definedColumns(requestUpdate)
  const assignments = columns.map((column, index) => `${column} = $${index + 1}`)
  values.push(existingChannelId, update.app_id, update.name)
  await withRlsContext(c, principal, client => client.query(
    `UPDATE public.channels SET ${assignments.join(', ')}
     WHERE id = $${values.length - 2} AND app_id = $${values.length - 1} AND name = $${values.length}`,
    values,
  ))
  return { data: null, error: null }
}

export async function updateOrCreateChannelDevice(c: Context, update: Database['public']['Tables']['channel_devices']['Insert']) {
  cloudlog({ requestId: c.get('requestId'), message: 'updateOrCreateChannelDevice', update })
  if (!update.device_id || !update.channel_id || !update.app_id) {
    cloudlog({ requestId: c.get('requestId'), message: 'missing device_id, channel_id, or app_id' })
    return Promise.resolve({ error: new Error('missing device_id, channel_id, or app_id') })
  }
  const { device_id, channel_id, app_id } = update
  try {
    return await withAdminPg(c, async (pg) => {
      // Lookup failures (like .single() with no row) just mean "no existing row": upsert anyway.
      const existingChannelDevice = await queryJson<Database['public']['Tables']['channel_devices']['Row']>(
        pg,
        'SELECT * FROM public.channel_devices WHERE device_id = $1 AND channel_id = $2 AND app_id = $3',
        [device_id, channel_id, app_id],
      ).then(rows => rows.length === 1 ? rows[0] : null, () => null)

      if (existingChannelDevice) {
        const fieldsDiffer = Object.keys(update).some(key =>
          (update as any)[key] !== (existingChannelDevice as any)[key] && key !== 'created_at' && key !== 'updated_at',
        )
        if (!fieldsDiffer) {
          cloudlog({ requestId: c.get('requestId'), message: 'No fields differ, no update needed' })
          return { error: null }
        }
      }

      const upsert = buildUpsertSql('public.channel_devices', update, ['app_id', 'device_id'])
      await pg.query(upsert.text, upsert.values)
      return { error: null }
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'updateOrCreateChannelDevice error', error })
    return { error }
  }
}

export async function checkAppOwner(c: Context, userId: string | undefined, appId: string | undefined): Promise<boolean> {
  if (!appId || !userId)
    return false
  try {
    const { rows } = await withAdminPg(c, pg => pg.query<{ owned: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM public.apps WHERE user_id = $1 AND app_id = $2) AS owned',
      [userId, appId],
    ))
    return rows[0]?.owned === true
  }
  catch (error) {
    cloudlogErr(error)
    return false
  }
}

export async function apikeyHasOrgRight(c: Context, key: Database['public']['Tables']['apikeys']['Row'], orgId: string) {
  if (!key.rbac_id)
    return false

  const pgClient = await getPgClient(c)
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
  principal: RlsPrincipal,
): Promise<{ valid: boolean, error?: string }> {
  if (!(await apikeyHasOrgRight(c, key, orgId))) {
    return { valid: false, error: 'invalid_org_id' }
  }

  const policyCheck = await checkApikeyMeetsOrgPolicy(c, key, orgId, principal)
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
  return singleRpcRow<PlanTotal>(c, 'SELECT * FROM public.get_total_metrics(org_id => $1::uuid)', [orgId])
}

const SINGLE_ROW_ERROR_MESSAGE = 'JSON object requested, multiple (or no) rows returned'

/** `.rpc(...).single()` as service role: the only row as PostgREST JSON, or an error when there is not exactly one. */
async function singleRpcRow<T>(c: Context, text: string, values: unknown[]): Promise<T> {
  const rows = await withAdminPg(c, pg => queryJson<T>(pg, text, values))
  if (rows.length !== 1)
    throw new Error(SINGLE_ROW_ERROR_MESSAGE)
  return rows[0]!
}

/** Scalar `.rpc(...)` as service role: the function's value, aliased `result` in `text`. */
async function scalarRpc<T>(c: Context, text: string, values: unknown[]): Promise<T | null> {
  const { rows } = await withAdminPg(c, pg => pg.query<{ result: T | null }>(text, values))
  return rows[0]?.result ?? null
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
  return singleRpcRow<PlanUsage>(c, 'SELECT * FROM public.get_plan_usage_percent_detailed(orgid => $1::uuid)', [orgId])
}

function readPlanUsageAndFit(c: Context, fn: 'get_plan_usage_and_fit' | 'get_plan_usage_and_fit_uncached', orgId: string): Promise<PlanUsageAndFit> {
  return singleRpcRow<PlanUsageAndFit>(c, `SELECT * FROM public.${fn}(orgid => $1::uuid)`, [orgId])
}

export async function getPlanUsageAndFit(c: Context, orgId: string): Promise<PlanUsageAndFit> {
  // When Stripe isn't configured, still compute usage via Postgres and derive fit from usage.
  // This avoids Stripe API calls while keeping plan enforcement deterministic for tests/on-prem.
  if (!isStripeConfigured(c)) {
    try {
      const data = await readPlanUsageAndFit(c, 'get_plan_usage_and_fit', orgId)
      return { ...data, is_good_plan: data.total_percent <= 100 }
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getPlanUsageAndFit (no stripe) fallback', orgId, error })
      const percentUsage = await getPlanUsagePercent(c, orgId)
      return { is_good_plan: percentUsage.total_percent <= 100, ...percentUsage }
    }
  }

  try {
    return await readPlanUsageAndFit(c, 'get_plan_usage_and_fit', orgId)
  }
  catch (error) {
    // Fallback when the RPC is unavailable or fails.
    cloudlogErr({ requestId: c.get('requestId'), message: 'getPlanUsageAndFit fallback', orgId, error })
    const percentUsage = await getPlanUsagePercent(c, orgId)
    return { is_good_plan: percentUsage.total_percent <= 100, ...percentUsage }
  }
}

export async function getPlanUsageAndFitUncached(c: Context, orgId: string): Promise<PlanUsageAndFit> {
  const isMissingFunction = (error: unknown) => {
    const message = error instanceof Error ? error.message : ''
    return message.includes('get_plan_usage_and_fit_uncached') || message.includes('schema cache')
  }

  if (!isStripeConfigured(c)) {
    try {
      const data = await readPlanUsageAndFit(c, 'get_plan_usage_and_fit_uncached', orgId).catch((error: unknown) => {
        if (isMissingFunction(error))
          return null
        throw error
      })
      if (!data)
        return getPlanUsageAndFit(c, orgId)
      return { ...data, is_good_plan: data.total_percent <= 100 }
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getPlanUsageAndFitUncached (no stripe) fallback', orgId, error })
      const percentUsage = await getPlanUsagePercent(c, orgId)
      return { is_good_plan: percentUsage.total_percent <= 100, ...percentUsage }
    }
  }

  try {
    return await readPlanUsageAndFit(c, 'get_plan_usage_and_fit_uncached', orgId)
  }
  catch (error) {
    if (isMissingFunction(error)) {
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
    const data = await scalarRpc<boolean>(c, 'SELECT public.is_good_plan_v5_org(orgid => $1::uuid) AS result', [orgId])

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
    const data = await scalarRpc<boolean>(c, 'SELECT public.is_onboarded_org(orgid => $1::uuid) AS result', [orgId])
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isOnboarded error', orgId, error })
  }
  return false
}

type StripeInfoExceededColumn = 'mau_exceeded' | 'storage_exceeded' | 'bandwidth_exceeded'

async function setStripeInfoExceededFlag(
  c: Context,
  column: StripeInfoExceededColumn,
  logName: string,
  customerId: string,
  disabled: boolean,
  logOrgId?: string,
): Promise<boolean> {
  let rowCount: number | null
  try {
    // Return the updated row key so we can detect "0 rows affected".
    rowCount = (await withAdminPg(c, pg => pg.query(
      `UPDATE public.stripe_info SET ${quoteIdent(column)} = $1 WHERE customer_id = $2 RETURNING customer_id`,
      [disabled, customerId],
    ))).rowCount
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: `${logName} error`, orgId: logOrgId, customerId, disabled, error })
    return false
  }
  // Treat "no row matched" as failure to avoid silently "succeeding" while not persisting the change.
  // This also protects against accidental mismatched `customerId`.
  if (!rowCount) {
    cloudlogErr({ requestId: c.get('requestId'), message: `${logName} no stripe_info row matched`, orgId: logOrgId, customerId, disabled })
    return false
  }
  return true
}

/**
 * Update the MAU exceeded flag for a Stripe customer.
 *
 * Note: `logOrgId` is used for logging/debugging only. The update is scoped by `customerId`.
 */
export async function set_mau_exceeded(c: Context, customerId: string | null, disabled: boolean, logOrgId?: string): Promise<boolean> {
  if (!customerId)
    return true
  return setStripeInfoExceededFlag(c, 'mau_exceeded', 'set_mau_exceeded', customerId, disabled, logOrgId)
}

/**
 * Update the storage exceeded flag for a Stripe customer.
 *
 * Note: `logOrgId` is used for logging/debugging only. The update is scoped by `customerId`.
 */
export async function set_storage_exceeded(c: Context, customerId: string | null, disabled: boolean, logOrgId?: string): Promise<boolean> {
  if (!customerId)
    return true
  return setStripeInfoExceededFlag(c, 'storage_exceeded', 'set_storage_exceeded', customerId, disabled, logOrgId)
}

/**
 * Update the bandwidth exceeded flag for a Stripe customer.
 *
 * Note: `logOrgId` is used for logging/debugging only. The update is scoped by `customerId`.
 */
export async function set_bandwidth_exceeded(c: Context, customerId: string | null, disabled: boolean, logOrgId?: string): Promise<boolean> {
  if (!customerId)
    return true
  return setStripeInfoExceededFlag(c, 'bandwidth_exceeded', 'set_bandwidth_exceeded', customerId, disabled, logOrgId)
}

export async function set_build_time_exceeded(c: Context, orgId: string, disabled: boolean): Promise<boolean> {
  try {
    await withAdminPg(c, pg => pg.query('SELECT public.set_build_time_exceeded_by_org(org_id => $1::uuid, disabled => $2::boolean)', [orgId, disabled]))
  }
  catch (error) {
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
    return await withAdminPg(c, async (pg) => {
      let data: string | null
      try {
        const { rows } = await pg.query<{ result: string | null }>(
          `SELECT public.record_build_time(
            p_org_id => $1::uuid,
            p_user_id => $2::uuid,
            p_build_id => $3::varchar,
            p_platform => $4::varchar,
            p_build_time_unit => $5::bigint,
            p_app_id => $6::varchar
          ) AS result`,
          [orgId, userId, buildId, platform, buildTimeSeconds, appId],
        )
        data = rows[0]?.result ?? null
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'recordBuildTime error', orgId, userId, buildId, error })
        return null
      }

      if (completedAt) {
        const completedAtIso = new Date(completedAt).toISOString()
        try {
          await pg.query(
            'UPDATE public.build_logs SET created_at = $1::timestamptz WHERE org_id = $2 AND build_id = $3',
            [completedAtIso, orgId, buildId],
          )
        }
        catch (updateError) {
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

      return data
    })
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
    return await singleRpcRow<{ total_build_time_unit: number, total_builds: number }>(
      c,
      'SELECT * FROM public.get_org_build_time_unit(p_org_id => $1::uuid, p_start_date => $2::date, p_end_date => $3::date)',
      [orgId, startDate, endDate],
    )
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getOrgBuildTimeSeconds error', orgId, error })
    return { total_build_time_unit: 0, total_builds: 0 }
  }
}

export async function isOnboardingNeeded(c: Context, userId: string): Promise<boolean> {
  try {
    const data = await scalarRpc<boolean>(c, 'SELECT public.is_onboarding_needed_org(orgid => $1::uuid) AS result', [userId])
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isOnboardingNeeded error', userId, error })
  }
  return false
}

export async function isCanceledOrg(c: Context, orgId: string): Promise<boolean> {
  try {
    const data = await scalarRpc<boolean>(c, 'SELECT public.is_canceled_org(orgid => $1::uuid) AS result', [orgId])
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isCanceled error', orgId, error })
  }
  return false
}

export async function isPayingOrg(c: Context, orgId: string): Promise<boolean> {
  try {
    const data = await scalarRpc<boolean>(c, 'SELECT public.is_paying_org(orgid => $1::uuid) AS result', [orgId])
    return data ?? false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isPayingOrg error', orgId, error })
  }
  return false
}

export async function isTrialOrg(c: Context, orgId: string): Promise<number> {
  try {
    const data = await scalarRpc<number>(c, 'SELECT public.is_trial_org(orgid => $1::uuid) AS result', [orgId])
    return data ?? 0
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'isTrialOrg error', orgId, error })
  }
  return 0
}

export async function isAllowedActionOrg(c: Context, orgId: string): Promise<boolean> {
  try {
    const data = await scalarRpc<boolean>(c, 'SELECT public.is_allowed_action_org(orgid => $1::uuid) AS result', [orgId])
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

  const pgPool = await getPgClient(c)
  let pgClient: PgQueryClient | undefined
  let inTransaction = false
  try {
    pgClient = await checkoutPgClient(pgPool)
    // on_user_update runs this for every profile change, and almost every user
    // already has keys. Bail out before locking the user row; the locked
    // recheck below still guards the rare first provisioning.
    const existingKeys = await pgClient.query<{ has_keys: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM public.apikeys WHERE user_id = $1::uuid) AS has_keys',
      [userId],
    )
    if (existingKeys.rows[0]?.has_keys)
      return
    await beginWriteTransaction(pgClient)
    inTransaction = true
    await pgClient.query(`SET LOCAL lock_timeout = '5s'`)

    // Serialize with delete_user(). Its to_delete_accounts FK check takes a
    // KEY SHARE lock on public.users, which conflicts with this UPDATE lock.
    // The separate query below therefore gets a fresh READ COMMITTED snapshot
    // after any in-flight deletion transaction has finished.
    const userLockResult = await pgClient.query(
      'SELECT id FROM public.users WHERE id = $1::uuid FOR UPDATE',
      [userId],
    )
    if (userLockResult.rowCount === 0) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'createApiKey error', userId, error: 'user not found' })
      await pgClient.query('ROLLBACK')
      return
    }

    const deletionResult = await pgClient.query<{ deletion_scheduled: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM public.to_delete_accounts
         WHERE account_id = $1::uuid
       ) AS deletion_scheduled`,
      [userId],
    )
    if (deletionResult.rows[0]?.deletion_scheduled) {
      cloudlog({ requestId: c.get('requestId'), message: 'createApiKey skipped, account deletion scheduled', userId })
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

    // Default keys are capped at the owner's own rights per org/app.
    await pgClient.query(
      CREATE_DEFAULT_API_KEYS_SQL,
      [userId],
    )
    await pgClient.query('COMMIT')
  }
  catch (error) {
    if (inTransaction && pgClient) {
      await pgClient.query('ROLLBACK').catch(() => {})
    }
    cloudlogErr({ requestId: c.get('requestId'), message: 'createApiKey error', userId, error })
    // A lock timeout is transient: let the queue retry instead of permanently
    // acknowledging user provisioning without a default API key.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03')
      throw error
  }
  finally {
    // Workerd keeps request-scoped Pools open, so destroy the checked-out
    // socket explicitly after the transaction and then close the Pool where
    // the runtime supports it.
    releasePgClient(pgPool, pgClient, true)
    closeClient(c, pgPool)
  }
}

export async function customerToSegmentOrg(
  c: Context,
  org: { id: string, created_by: string },
  price_id?: string | null,
  plan?: Database['public']['Tables']['plans']['Row'] | null,
  trialPlanNamesToRemove?: readonly string[] | null,
): Promise<{ segments: string[], deleteSegments: string[] }> {
  // Direct-offer (paid ads) orgs never had a trial: tag offer=direct and strip trial tags.
  // Callers already loaded the org, so reuse its created_by instead of re-reading it.
  // An unknown offer (lookup failed) only withholds trial tags until a later sync.
  const directOffer = await getDirectOfferStatus(c, supabaseAdmin(c), org.created_by)
  return applyDirectOfferBentoTags(await customerToSegmentOrgBase(c, org.id, price_id, plan, trialPlanNamesToRemove), directOffer, trialPlanNamesToRemove)
}

async function customerToSegmentOrgBase(
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
    payingMonthly: !!plan && getPlanPriceInterval(plan, price_id) === 'monthly',
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
  const rows = await withAdminPg(c, pg => queryJson<Database['public']['Tables']['stripe_info']['Row']>(
    pg,
    'SELECT * FROM public.stripe_info WHERE customer_id = $1',
    [customerId],
  ))
  if (rows.length > 1)
    throw new Error(SINGLE_ROW_ERROR_MESSAGE)
  return rows[0] ?? null
}

export async function getDefaultPlan(c: Context) {
  try {
    const rows = await withAdminPg(c, pg => queryJson<Database['public']['Tables']['plans']['Row']>(
      pg,
      'SELECT * FROM public.plans WHERE name = $1',
      ['Solo'],
    ))
    return rows.length === 1 ? rows[0]! : null
  }
  catch {
    return null
  }
}

export function trackBandwidthUsageSB(
  c: Context,
  deviceId: string,
  appId: string,
  fileSize: number,
) {
  return insertAdminRow(c, 'public.bandwidth_usage', {
    device_id: deviceId.toLowerCase(),
    app_id: appId,
    file_size: fileSize,
  }, 'trackBandwidthUsageSB error')
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
  return insertAdminRow(c, 'public.version_usage', {
    version_name: versionName,
    app_id: appId,
    action,
    channel_name: channelName ?? null,
    channel_id: channelId ?? null,
  }, 'trackVersionUsageSB error')
}

export function trackDeviceUsageSB(
  c: Context,
  deviceId: string,
  appId: string,
  orgId: string,
  platform: string,
  versionBuild?: string | null,
) {
  return insertAdminRow(c, 'public.device_usage', {
    device_id: deviceId.toLowerCase(),
    app_id: appId,
    org_id: orgId,
    platform: platform || 'unknown',
    version_build: versionBuild || 'unknown',
  }, 'trackDeviceUsageSB error')
}

export async function trackMetaSB(
  c: Context,
  app_id: string,
  version_id: number,
  size: number,
): Promise<{ data: boolean | null, error: unknown | null }> {
  cloudlog({ requestId: c.get('requestId'), message: 'createStatsMeta', app_id, version_id, size })
  try {
    const data = await scalarRpc<boolean>(
      c,
      'SELECT public.upsert_version_meta(p_app_id => $1::varchar, p_version_id => $2::bigint, p_size => $3::bigint) AS result',
      [app_id, version_id, size],
    )
    return { data, error: null }
  }
  catch (error) {
    return { data: null, error }
  }
}

export async function trackDevicesSB(c: Context, device: DeviceWithoutCreatedAt) {
  cloudlog({ requestId: c.get('requestId'), message: 'trackDevicesSB', device })
  try {
    // One connection for the lookup and the write.
    return await withAdminPg(c, pg => trackDeviceWithPg(c, pg, device))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trackDevicesSB connection error', error })
    return { error }
  }
}

async function trackDeviceWithPg(c: Context, pg: PgClient, device: DeviceWithoutCreatedAt) {
  type ExistingDeviceRow = Pick<Database['public']['Tables']['devices']['Row'], 'version_name' | 'platform' | 'plugin_version' | 'os_version' | 'version_build' | 'custom_id' | 'is_prod' | 'is_emulator' | 'install_source' | 'default_channel' | 'key_id' | 'country_code'>
  let existingRow: ExistingDeviceRow | null = null
  try {
    const rows = await queryJson<ExistingDeviceRow>(
      pg,
      `SELECT version_name, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator, install_source, default_channel, key_id, country_code
       FROM public.devices
       WHERE app_id = $1 AND device_id = $2`,
      [device.app_id, device.device_id],
    )
    if (rows.length > 1)
      throw new Error(SINGLE_ROW_ERROR_MESSAGE)
    existingRow = rows[0] ?? null
  }
  catch (error) {
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
    return undefined
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

  try {
    const upsert = buildUpsertSql('public.devices', payload, ['device_id', 'app_id'])
    await pg.query(upsert.text, upsert.values)
    return { error: null }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trackDevicesSB upsert error', error })
    return { error }
  }
}

export function trackLogsSB(c: Context, app_id: string, device_id: string, action: Database['public']['Enums']['stats_action'], version_name: string, metadata?: StatsMetadata) {
  return insertAdminRow(c, 'public.stats', {
    app_id,
    created_at: new Date().toISOString(),
    device_id,
    action,
    version_name,
    metadata,
  }, 'trackLogsSB error')
}

type UsageRpc = 'read_device_usage' | 'read_bandwidth_usage' | 'read_storage_usage' | 'read_version_usage'
type UsageRpcRows<F extends UsageRpc> = Database['public']['Functions'][F]['Returns']

/**
 * Service-role read of a usage RPC's rows as PostgREST JSON. Errors were ignored by these callers
 * (supabase-js `data ?? []`), so they still resolve to no rows; they are logged now.
 */
async function readUsageRpc<F extends UsageRpc>(c: Context, fn: F, args: Record<string, unknown>): Promise<UsageRpcRows<F>> {
  const entries = Object.entries(args)
  const namedArgs = entries.map(([name], index) => `${quoteIdent(name)} => $${index + 1}`)
  try {
    return await withAdminPg(c, pg => queryJson(pg, `SELECT * FROM public.${fn}(${namedArgs.join(', ')})`, entries.map(([, value]) => value))) as UsageRpcRows<F>
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: `Error reading ${fn}`, app_id: args.p_app_id, error })
    return [] as unknown as UsageRpcRows<F>
  }
}

export function readDeviceUsageSB(c: Context, app_id: string, period_start: string, period_end: string) {
  return readUsageRpc(c, 'read_device_usage', { p_app_id: app_id, p_period_start: period_start, p_period_end: period_end })
}

export function readBandwidthUsageSB(c: Context, app_id: string, period_start: string, period_end: string) {
  return readUsageRpc(c, 'read_bandwidth_usage', { p_app_id: app_id, p_period_start: period_start, p_period_end: period_end })
}

export function readStatsStorageSB(c: Context, app_id: string, period_start: string, period_end: string) {
  return readUsageRpc(c, 'read_storage_usage', { p_app_id: app_id, p_period_start: period_start, p_period_end: period_end })
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
  const data = await readUsageRpc(c, 'read_version_usage', args)
  // Cast to VersionUsage[] - the SQL function returns version_name but auto-generated types are stale
  return data as unknown as VersionUsage[]
}

type NativeUsageRpc = 'read_native_version_usage' | 'read_native_active_devices_summary' | 'read_native_daily_platform_active'

/** Native usage RPCs authorize the caller themselves, so they run as the request principal (RLS on). */
async function readNativeUsageRpc<T>(c: Context, fn: NativeUsageRpc, principal: RlsPrincipal, app_id: string, period_start: string, period_end: string, logMessage: string): Promise<T[]> {
  try {
    return await withRlsContext(c, principal, client => queryJson<T>(
      client,
      `SELECT * FROM public.${fn}(p_app_id => $1::varchar, p_period_start => $2::timestamp, p_period_end => $3::timestamp)`,
      [app_id, period_start, period_end],
    ))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: logMessage, error })
    throw error
  }
}

export function readNativeVersionUsageSB(c: Context, app_id: string, period_start: string, period_end: string, principal: RlsPrincipal): Promise<NativeVersionUsage[]> {
  return readNativeUsageRpc<NativeVersionUsage>(c, 'read_native_version_usage', principal, app_id, period_start, period_end, 'Error reading native version usage')
}

export async function readNativeActiveDevicesSummarySB(
  c: Context,
  app_id: string,
  period_start: string,
  period_end: string,
  principal: RlsPrincipal,
): Promise<NativeActiveDevicesByPlatformRow[]> {
  const data = await readNativeUsageRpc<{ platform?: string | null, devices?: number | string | null }>(c, 'read_native_active_devices_summary', principal, app_id, period_start, period_end, 'Error reading native active devices summary')

  return data.map(row => ({
    platform: row.platform ?? 'unknown',
    devices: Math.max(0, Number(row.devices) || 0),
  }))
}

export async function readNativeDailyPlatformActiveSB(
  c: Context,
  app_id: string,
  period_start: string,
  period_end: string,
  principal: RlsPrincipal,
): Promise<Array<{ date: string, platform: string, devices: number }>> {
  const data = await readNativeUsageRpc<{ date?: string | null, platform?: string | null, devices?: number | string | null }>(c, 'read_native_daily_platform_active', principal, app_id, period_start, period_end, 'Error reading native daily platform active')

  return data.map(row => ({
    date: row.date ?? '',
    platform: row.platform ?? 'unknown',
    devices: Math.max(0, Number(row.devices) || 0),
  }))
}

/**
 * Upper bound of channel_devices ids inlined into one device count query. Keeps
 * the Analytics Engine SQL (and PostgREST filters) bounded for apps with huge
 * override lists; overflow is logged and the extra overrides are ignored.
 */
export const MAX_CHANNEL_DEVICE_OVERRIDES_FOR_COUNTS = 1000
const CHANNEL_DEVICE_OVERRIDES_SCAN_LIMIT = 5000

interface ChannelDeviceOverrideRow {
  device_id: string
  channel_id: number
  channels?: { name?: string | null } | Array<{ name?: string | null }> | null
}

/**
 * Split an app's channel_devices rows into devices forced into `channel` and
 * devices forced elsewhere. Matches by channel id when known, otherwise by name.
 * Device ids are lowercased, matching plugin ingestion.
 * Forced-into devices are kept first when the combined list must be capped, so
 * past the cap some forced-elsewhere ids are dropped: those devices still count
 * under their reported default_channel, which can inflate this channel's counts
 * (never deflate them). The cap is logged by readChannelDeviceOverrideIdsSB.
 */
export function partitionChannelDeviceOverrides(
  rows: ChannelDeviceOverrideRow[],
  channel: VersionUsageChannel | string,
  limit = MAX_CHANNEL_DEVICE_OVERRIDES_FOR_COUNTS,
): ChannelDeviceOverrideIds & { truncated: boolean } {
  const channelId = typeof channel === 'object' && channel.id ? Number(channel.id) : null
  const channelName = typeof channel === 'string' ? channel : (channel.name ?? null)
  const into = new Set<string>()
  const elsewhere = new Set<string>()

  for (const row of rows) {
    if (!row.device_id)
      continue
    const deviceId = row.device_id.toLowerCase()
    const rowChannel = Array.isArray(row.channels) ? row.channels[0] : row.channels
    const matches = channelId !== null
      ? Number(row.channel_id) === channelId
      : Boolean(channelName) && rowChannel?.name === channelName
    if (matches)
      into.add(deviceId)
    else
      elsewhere.add(deviceId)
  }
  // A device has at most one override per app; guard against duplicates anyway.
  for (const deviceId of into)
    elsewhere.delete(deviceId)

  const intoList = [...into].slice(0, limit)
  const elsewhereList = [...elsewhere].slice(0, Math.max(0, limit - intoList.length))
  return {
    into: intoList,
    elsewhere: elsewhereList,
    truncated: intoList.length < into.size || elsewhereList.length < elsewhere.size,
  }
}

/**
 * Load channel_devices overrides for scoping device counts of one channel.
 * Returns undefined on error so callers fall back to default_channel-only counts.
 */
export async function readChannelDeviceOverrideIdsSB(c: Context, app_id: string, channel: VersionUsageChannel | string): Promise<ChannelDeviceOverrideIds | undefined> {
  let rows: ChannelDeviceOverrideRow[]
  try {
    rows = await withAdminPg(c, pg => queryJson<ChannelDeviceOverrideRow>(
      pg,
      `SELECT cd.device_id, cd.channel_id,
        (SELECT json_build_object('name', ch.name) FROM public.channels ch WHERE ch.id = cd.channel_id) AS channels
       FROM public.channel_devices cd
       WHERE cd.app_id = $1
       ORDER BY cd.updated_at DESC
       LIMIT $2`,
      [app_id, CHANNEL_DEVICE_OVERRIDES_SCAN_LIMIT + 1],
    ))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading channel_devices overrides for device counts', app_id, error })
    return undefined
  }

  const partitioned = partitionChannelDeviceOverrides(rows.slice(0, CHANNEL_DEVICE_OVERRIDES_SCAN_LIMIT), channel)
  if (partitioned.truncated || rows.length > CHANNEL_DEVICE_OVERRIDES_SCAN_LIMIT) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'channel_devices overrides capped for device counts',
      app_id,
      scanned: Math.min(rows.length, CHANNEL_DEVICE_OVERRIDES_SCAN_LIMIT),
      into: partitioned.into.length,
      elsewhere: partitioned.elsewhere.length,
      limit: MAX_CHANNEL_DEVICE_OVERRIDES_FOR_COUNTS,
    })
  }
  return { into: partitioned.into, elsewhere: partitioned.elsewhere }
}

const CHANNEL_DEVICE_PLATFORMS: ChannelDevicePlatform[] = ['ios', 'android', 'electron']

interface PublicChannelRow {
  id: number
  name: string
  ios: boolean
  android: boolean
  electron: boolean
}

/**
 * Platforms where `channel` is the public default. /updates serves devices that
 * report no default_channel the first public channel enabled for their platform,
 * ordered by name then id, so `rows` must keep that order.
 */
export function pickChannelDefaultPlatforms(rows: PublicChannelRow[], channel: VersionUsageChannel | string): ChannelDevicePlatform[] {
  const channelId = typeof channel === 'object' && channel.id ? Number(channel.id) : null
  const channelName = typeof channel === 'string' ? channel : (channel.name ?? null)
  return CHANNEL_DEVICE_PLATFORMS.filter((platform) => {
    const fallback = rows.find(row => row[platform])
    if (!fallback)
      return false
    return channelId !== null ? fallback.id === channelId : fallback.name === channelName
  })
}

/**
 * Platforms where `channel` is the public default, read from the app's public
 * channels. Returns none on error so counts fall back to reported channels.
 */
export async function readChannelDefaultPlatformsSB(c: Context, app_id: string, channel: VersionUsageChannel | string): Promise<ChannelDevicePlatform[]> {
  try {
    const rows = await withAdminPg(c, pg => queryJson<PublicChannelRow>(
      pg,
      `SELECT id, name, ios, android, electron
       FROM public.channels
       WHERE app_id = $1 AND public = true
       ORDER BY name ASC, id ASC`,
      [app_id],
    ))
    return pickChannelDefaultPlatforms(rows, channel)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading public channels for device counts', app_id, error })
    return []
  }
}

/**
 * Count devices per version for the effective channel: default_channel matches
 * minus devices forced elsewhere, plus devices forced into the channel.
 */
export function countChannelScopedDeviceVersions(
  defaultChannelRows: Array<{ device_id: string, version_name: string | null }>,
  forcedIntoRows: Array<{ device_id: string, version_name: string | null }>,
  overrides?: ChannelDeviceOverrideIds,
): Record<string, number> {
  const elsewhere = new Set((overrides?.elsewhere ?? []).map(id => id.toLowerCase()))
  const versionByDevice = new Map<string, string | null>()
  for (const row of defaultChannelRows) {
    const deviceId = row.device_id.toLowerCase()
    if (!elsewhere.has(deviceId))
      versionByDevice.set(deviceId, row.version_name)
  }
  for (const row of forcedIntoRows)
    versionByDevice.set(row.device_id.toLowerCase(), row.version_name)

  const counts: Record<string, number> = {}
  for (const versionName of versionByDevice.values()) {
    const version = versionName || 'unknown'
    counts[version] = (counts[version] || 0) + 1
  }
  return counts
}

interface DeviceVersionRow { device_id: string, version_name: string | null }

/**
 * Device counts per version from the devices table, scoped to the effective
 * channel when `channelName` is set (see readDeviceVersionCounts).
 */
export async function readDeviceVersionCountsSB(
  c: Context,
  app_id: string,
  channelName?: string,
  overrides?: ChannelDeviceOverrideIds,
): Promise<Record<string, number>> {
  const pgClient = await getPgClient(c)
  try {
    let defaultChannelRows: DeviceVersionRow[]
    try {
      const result = channelName
        ? await pgClient.query<DeviceVersionRow>('SELECT device_id, version_name FROM public.devices WHERE app_id = $1 AND default_channel = $2', [app_id, channelName])
        : await pgClient.query<DeviceVersionRow>('SELECT device_id, version_name FROM public.devices WHERE app_id = $1', [app_id])
      defaultChannelRows = result.rows
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device version counts', error })
      return {}
    }

    const defaultForPlatforms = channelName ? (overrides?.defaultForPlatforms ?? []) : []
    if (defaultForPlatforms.length) {
      try {
        const { rows } = await pgClient.query<DeviceVersionRow>(
          `SELECT device_id, version_name FROM public.devices
           WHERE app_id = $1 AND (default_channel IS NULL OR default_channel = '') AND platform::text = ANY($2::text[])`,
          [app_id, defaultForPlatforms],
        )
        defaultChannelRows.push(...rows)
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading default channel devices for version counts', error })
      }
    }

    let forcedIntoRows: DeviceVersionRow[] = []
    const into = channelName ? (overrides?.into ?? []) : []
    if (into.length) {
      try {
        forcedIntoRows = (await pgClient.query<DeviceVersionRow>(
          'SELECT device_id, version_name FROM public.devices WHERE app_id = $1 AND device_id = ANY($2::text[])',
          [app_id, into],
        )).rows
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading forced channel devices for version counts', error })
      }
    }

    return countChannelScopedDeviceVersions(defaultChannelRows, forcedIntoRows, channelName ? overrides : undefined)
  }
  finally {
    closeClient(c, pgClient)
  }
}

/**
 * Retrieve stats entries for the given app, honoring the optional filters and sorting provided in `params`.
 */
export async function readStatsSB(c: Context, params: ReadStatsParams) {
  const values: unknown[] = [params.app_id]
  const clauses = ['app_id = $1']
  const addValue = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }

  if (params.start_date)
    clauses.push(`created_at >= ${addValue(new Date(params.start_date).toISOString())}::timestamptz`)

  if (params.end_date)
    clauses.push(`created_at < ${addValue(new Date(params.end_date).toISOString())}::timestamptz`)

  if (params.deviceIds?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'deviceIds', deviceIds: params.deviceIds })
    clauses.push(`device_id = ANY(${addValue(params.deviceIds)}::text[])`)
  }

  if (params.actions?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'actions filter', actions: params.actions })
    clauses.push(`action = ANY(${addValue(params.actions)}::public.stats_action[])`)
  }

  if (params.version_name) {
    cloudlog({ requestId: c.get('requestId'), message: 'version_name', versionName: params.version_name })
    clauses.push(`version_name = ${addValue(params.version_name)}`)
  }

  if (params.search) {
    cloudlog({ requestId: c.get('requestId'), message: 'search', search: params.search })
    const searchPattern = addValue(`%${params.search}%`)
    const orFilters = params.deviceIds?.length
      ? [`version_name ILIKE ${searchPattern}`]
      : [`device_id ILIKE ${searchPattern}`, `version_name ILIKE ${searchPattern}`]

    const matchedActions = Constants.public.Enums.stats_action
      .filter(action => action.toLowerCase().includes(params.search!.toLowerCase()))
    if (matchedActions.length)
      orFilters.push(`action = ANY(${addValue(matchedActions)}::public.stats_action[])`)

    clauses.push(`(${orFilters.join(' OR ')})`)
  }

  const orderBy: string[] = []
  for (const col of params.order ?? []) {
    if (col.sortable && typeof col.sortable === 'string') {
      cloudlog({ requestId: c.get('requestId'), message: 'order', key: col.key, sortable: col.sortable })
      // PostgREST rejected unknown order columns; an invalid name still yields the error branch below.
      const key = String(col.key)
      if (!SQL_IDENTIFIER_RE.test(key)) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading stats list', error: `Invalid order column: ${key}` })
        return []
      }
      orderBy.push(`${quoteIdent(key)} ${col.sortable === 'asc' ? 'ASC' : 'DESC'}`)
    }
  }

  const limit = addValue(params.limit ?? DEFAULT_LIMIT)
  try {
    return await withAdminPg(c, pg => queryJson<Database['public']['Tables']['stats']['Row']>(
      pg,
      `SELECT * FROM public.stats WHERE ${clauses.join(' AND ')}${orderBy.length ? ` ORDER BY ${orderBy.join(', ')}` : ''} LIMIT ${limit}`,
      values,
    ))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading stats list', error })
    return []
  }
}

export async function readStatsInsightsSB(c: Context, params: ReadStatsInsightsParams): Promise<StatsInsightsResult> {
  const pgClient = await getPgClient(c)
  const actionValues = params.actions?.length ? params.actions : []
  const versionName = params.version_name?.trim()
  const values: unknown[] = [params.app_id, params.start_date, params.end_date]
  const extraFilters: string[] = []
  if (actionValues.length > 0) {
    extraFilters.push(`AND action = ANY($${values.length + 1}::public.stats_action[])`)
    values.push(actionValues)
  }
  if (versionName) {
    extraFilters.push(`AND version_name = $${values.length + 1}`)
    values.push(versionName)
  }
  const extraFilter = extraFilters.join('\n        ')

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
        ${extraFilter}
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
        ${extraFilter}
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
        ${extraFilter}
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
        ${extraFilter}
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
        ${extraFilter}
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
  cloudlog({ requestId: c.get('requestId'), message: 'readDevicesSB', params })
  return await readDevicesSBSql(c, params, customIdMode)
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
  versionName?: string | string[],
  search?: string,
  options?: {
    platform?: Database['public']['Enums']['platform_os']
    defaultChannel?: string
    updatedAt?: { gt?: string, lte?: string }
    osVersionCompare?: ReadDevicesParams['os_version_compare']
    versionNameCompare?: ReadDevicesParams['version_name_compare']
  },
) {
  return countDevicesSBSql(c, app_id, customIdMode, deviceIds, versionName, search, options)
}

const DEFAULT_PLAN_NAME = 'Solo'

// Enterprise MAU slider: MAU bought on top of the plan allowance (part of the plan quota).
export async function getOrgExtraMau(c: Context, orgId: string): Promise<number> {
  try {
    const { rows } = await withAdminPg(c, pg => pg.query<{ extra_mau: number | string | null }>(
      `SELECT si.extra_mau
       FROM public.orgs o
       LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
       WHERE o.id = $1`,
      [orgId],
    ))
    return Number(rows[0]?.extra_mau ?? 0)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getOrgExtraMau', orgId, error })
    return 0
  }
}

export async function getCurrentPlanNameOrg(c: Context, orgId?: string): Promise<string> {
  if (!orgId)
    return DEFAULT_PLAN_NAME
  let data: string | null
  try {
    data = await scalarRpc<string>(c, 'SELECT public.get_current_plan_name_org(orgid => $1::uuid) AS result', [orgId])
  }
  catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }

  return data ?? DEFAULT_PLAN_NAME
}

/**
 * Check API key by key string
 * Uses find_apikey_by_value SQL function to look up both plain-text and hashed keys
 * Expiration is checked after lookup
 */
export async function checkKey(c: Context, authorization: string | undefined): Promise<Database['public']['Tables']['apikeys']['Row'] | null> {
  if (!authorization)
    return null

  try {
    // Use find_apikey_by_value SQL function to look up both plain-text and hashed keys
    let rows: Database['public']['Tables']['apikeys']['Row'][]
    try {
      rows = await withAdminPg(c, pg => queryJson<Database['public']['Tables']['apikeys']['Row']>(
        pg,
        'SELECT * FROM public.find_apikey_by_value(key_value => $1::text)',
        [authorization],
      ))
    }
    catch (error) {
      // Database overload/connection loss must not look like a bad key (flaky 401s in CI).
      if (isTransientPgError(error)) {
        const message = error instanceof Error ? error.message : String(error)
        cloudlog({ requestId: c.get('requestId'), message: 'Apikey lookup upstream failure', authorizationPrefix: authorization?.substring(0, 8), error })
        throw quickError(503, 'upstream_unavailable', 'Upstream unavailable', { error: message })
      }
      cloudlog({ requestId: c.get('requestId'), message: 'Invalid apikey', authorizationPrefix: authorization?.substring(0, 8), error })
      return null
    }
    // Mirrors `.single()`: anything but exactly one match is an invalid key.
    const data = rows.length === 1 ? rows[0]! : null
    if (!data) {
      cloudlog({ requestId: c.get('requestId'), message: 'Invalid apikey', authorizationPrefix: authorization?.substring(0, 8) })
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
    if (error instanceof HTTPException)
      throw error
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
  userId?: string,
): Promise<Database['public']['Tables']['apikeys']['Row'] | null> {
  if (!id)
    return null
  try {
    // Expiration check is done in SQL: expires_at IS NULL OR expires_at > now()
    const values: unknown[] = [id]
    let userFilter = ''
    if (userId) {
      values.push(userId)
      userFilter = ' AND user_id = $2'
    }
    const rows = await withAdminPg(c, pg => queryJson<Database['public']['Tables']['apikeys']['Row']>(
      pg,
      `SELECT * FROM public.apikeys WHERE id = $1 AND (expires_at IS NULL OR expires_at > now())${userFilter}`,
      values,
    ))
    return rows.length === 1 ? rows[0]! : null
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
  c: Context,
  principal: RlsPrincipal,
  options: {
    limitedToApps?: string[] | null
    limitedToOrgs?: string[] | null
    policyLookupPrincipal?: RlsPrincipal
  },
): Promise<string[]> {
  const orgIds = new Set((options.limitedToOrgs ?? []).filter(Boolean))
  const limitedToApps = [...new Set((options.limitedToApps ?? []).filter(Boolean))]

  if (limitedToApps.length === 0) {
    return [...orgIds]
  }

  const resolvedAppIds = new Set<string>()

  async function addResolvedApps(lookupPrincipal: RlsPrincipal, appIds: string[]) {
    if (appIds.length === 0) {
      return
    }

    let apps: { app_id: string | null, owner_org: string | null }[]
    try {
      apps = await withRlsContext(c, lookupPrincipal, async client => (await client.query<{ app_id: string | null, owner_org: string | null }>(
        'SELECT app_id, owner_org FROM public.apps WHERE app_id = ANY($1::text[])',
        [appIds],
      )).rows)
    }
    catch (error) {
      throw simpleError('failed_to_resolve_apikey_policy_scope', 'Failed to resolve API key policy scope', { supabaseError: error })
    }

    for (const app of apps) {
      if (!app.app_id || !app.owner_org)
        continue
      resolvedAppIds.add(app.app_id)
      orgIds.add(app.owner_org)
    }
  }

  await addResolvedApps(principal, limitedToApps)

  let unresolvedAppIds = limitedToApps.filter(appId => !resolvedAppIds.has(appId))
  if (unresolvedAppIds.length > 0 && options.policyLookupPrincipal) {
    // Hidden apps still need owner-org policy enforcement even when caller RLS cannot see them.
    await addResolvedApps(options.policyLookupPrincipal, unresolvedAppIds)
    unresolvedAppIds = unresolvedAppIds.filter(appId => !resolvedAppIds.has(appId))
  }

  if (unresolvedAppIds.length > 0) {
    throw simpleError('failed_to_resolve_apikey_policy_scope', 'Failed to resolve API key policy scope', { unresolvedAppIds })
  }

  return [...orgIds]
}

interface ApiKeyExpirationPolicyRow {
  require_apikey_expiration?: boolean | null
  max_apikey_expiration_days?: number | null
}

/**
 * Validate API key expiration against already-loaded org policy rows.
 * Throws simpleError if any org policy is violated.
 */
export function assertExpirationMatchesOrgPolicies(
  orgs: ApiKeyExpirationPolicyRow[],
  expiresAt: string | null,
): void {
  for (const org of orgs) {
    if (org.require_apikey_expiration && !expiresAt) {
      throw simpleError('expiration_required', 'This organization requires API keys to have an expiration date')
    }

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
 * Validate API key expiration against org policies for multiple orgs.
 * Throws simpleError if any org policy is violated.
 * @param orgIds - Array of org IDs to validate against
 * @param expiresAt - The expiration date string
 * @param principal - Who reads the org policies (RLS applies unless it is the service principal)
 */
export async function validateExpirationAgainstOrgPolicies(
  c: Context,
  orgIds: string[],
  expiresAt: string | null,
  principal: RlsPrincipal,
): Promise<void> {
  if (orgIds.length === 0) {
    return
  }

  // Fetch all org policies in a single query. Lookup errors were ignored (no policies to enforce).
  let orgs: ApiKeyExpirationPolicyRow[]
  try {
    orgs = await withRlsContext(c, principal, async client => (await client.query<ApiKeyExpirationPolicyRow>(
      'SELECT id, require_apikey_expiration, max_apikey_expiration_days FROM public.orgs WHERE id = ANY($1::uuid[])',
      [orgIds],
    )).rows)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'validateExpirationAgainstOrgPolicies: unable to load org policies', orgIds, error })
    return
  }

  if (orgs.length === 0) {
    return
  }

  assertExpirationMatchesOrgPolicies(orgs, expiresAt)
}

/** `orgs.select(column).eq('id', orgId).single()` as `principal`: the row, or null unless exactly one is visible. */
async function selectSingleOrgColumn<T>(
  c: Context,
  principal: RlsPrincipal,
  column: 'require_apikey_expiration' | 'enforce_hashed_api_keys',
  orgId: string,
): Promise<T | null> {
  const rows = await withRlsContext(c, principal, async client => (await client.query<T & object>(
    `SELECT ${quoteIdent(column)} FROM public.orgs WHERE id = $1`,
    [orgId],
  )).rows)
  return rows.length === 1 ? rows[0]! : null
}

/**
 * Check if an API key meets org policy at usage time
 */
export async function checkApikeyMeetsOrgPolicy(
  c: Context,
  key: Database['public']['Tables']['apikeys']['Row'],
  orgId: string,
  principal: RlsPrincipal,
): Promise<{ valid: boolean, error?: string }> {
  let org: { require_apikey_expiration: boolean } | null = null
  let error: unknown = null
  try {
    org = await selectSingleOrgColumn<{ require_apikey_expiration: boolean }>(c, principal, 'require_apikey_expiration', orgId)
  }
  catch (lookupError) {
    error = lookupError
  }

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
  principal: RlsPrincipal,
): Promise<boolean> {
  try {
    // Check if org enforces hashed keys
    const org = await selectSingleOrgColumn<{ enforce_hashed_api_keys: boolean }>(c, principal, 'enforce_hashed_api_keys', orgId)
      .catch(() => null)

    if (!org) {
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
