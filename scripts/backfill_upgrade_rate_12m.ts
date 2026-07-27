/*
 * Backfill public.global_stats.upgrade_rate_12m for paying -> bigger plan moves.
 *
 * Numerator: Stripe-sourced daily upgrade counts in global_stats.upgraded_orgs
 * (monthly->yearly or MRR increase while already paying). Historical rows were
 * filled from Stripe subscription intervals; do not use stripe_info.upgraded_at
 * for history (that column is new / sparse).
 *
 * For each snapshot day D:
 *   sum(upgraded_orgs) over date_ids in [D+1-12 calendar months, D]
 *   / paying orgs on day D (global_stats.paying)
 *   * 100
 *
 * Dry run, defaulting to the last 30 UTC calendar days:
 *   bun run stripe:backfill-upgrade-rate-12m
 *
 * Apply a date range:
 *   bun run stripe:backfill-upgrade-rate-12m --apply --from=2024-01-01 --to=2026-07-21
 *
 * Apply every stored global_stats row:
 *   bun run stripe:backfill-upgrade-rate-12m --apply --all
 */
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import process from 'node:process'
import { asyncPool, createSupabaseServiceClient, DEFAULT_ENV_FILE, getArgValue, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const DEFAULT_LOOKBACK_DAYS = 30
const DEFAULT_CONCURRENCY = 10
const DEFAULT_PAGE_SIZE = 1000
const DATE_ID_REGEX = /^\d{4}-\d{2}-\d{2}$/

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>
type GlobalStatsRow = Pick<Database['public']['Tables']['global_stats']['Row'], 'date_id' | 'paying' | 'upgrade_rate_12m' | 'upgraded_orgs'>

export interface UpgradeRate12mBackfillRow {
  changed: boolean
  current_rate: number
  date_id: string
  next_rate: number
  paying: number
  upgraded_orgs_12m: number
}

function getDateId(targetDate = new Date()) {
  return new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate())).toISOString().slice(0, 10)
}

function assertDateId(value: string, label: string) {
  if (!DATE_ID_REGEX.test(value))
    throw new Error(`${label} must use YYYY-MM-DD`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || getDateId(parsed) !== value)
    throw new Error(`${label} must be a valid UTC calendar date`)
  return value
}

function getDefaultFromDateId(referenceDate = new Date()) {
  const date = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()))
  date.setUTCDate(date.getUTCDate() - DEFAULT_LOOKBACK_DAYS + 1)
  return getDateId(date)
}

function getNextDateId(dateId: string) {
  const date = new Date(`${dateId}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return getDateId(date)
}

function getTrailing12mStartDateId(dateId: string) {
  const endExclusive = new Date(`${getNextDateId(dateId)}T00:00:00.000Z`)
  const year = endExclusive.getUTCFullYear() - 1
  const month = endExclusive.getUTCMonth()
  const day = endExclusive.getUTCDate()
  const clampedDay = Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
  return getDateId(new Date(Date.UTC(year, month, clampedDay)))
}

function toMetricNumber(value: number | string | null | undefined) {
  const numberValue = Number(value ?? 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

export function calculateUpgradeRate12m(upgradedOrgs: number | string | null | undefined, paying: number | string | null | undefined) {
  const upgradedCount = toMetricNumber(upgradedOrgs)
  const payingCount = toMetricNumber(paying)
  if (payingCount <= 0)
    return 0
  return Number(((upgradedCount * 100) / payingCount).toFixed(1))
}

function hasRateChanged(currentRate: number, nextRate: number) {
  return Math.abs(currentRate - nextRate) > 0.0001
}

export function buildUpgradeRate12mBackfillRows(
  rows: GlobalStatsRow[],
  allUpgradeRows: GlobalStatsRow[],
): UpgradeRate12mBackfillRow[] {
  const upgradedByDateId = new Map(
    allUpgradeRows.map(row => [row.date_id, toMetricNumber(row.upgraded_orgs)]),
  )
  const sortedUpgradeDateIds = [...upgradedByDateId.keys()].sort((left, right) => left.localeCompare(right))
  const prefixSums: Array<{ date_id: string, sum: number }> = []
  let running = 0
  for (const dateId of sortedUpgradeDateIds) {
    running += upgradedByDateId.get(dateId) ?? 0
    prefixSums.push({ date_id: dateId, sum: running })
  }

  function sumUpgradedInclusive(fromDateId: string, toDateId: string) {
    if (fromDateId > toDateId)
      return 0
    let before = 0
    let through = 0
    for (const entry of prefixSums) {
      if (entry.date_id < fromDateId)
        before = entry.sum
      if (entry.date_id <= toDateId)
        through = entry.sum
      else
        break
    }
    return through - before
  }

  return [...rows]
    .sort((left, right) => left.date_id.localeCompare(right.date_id))
    .map((row) => {
      const fromDateId = getTrailing12mStartDateId(row.date_id)
      const upgraded_orgs_12m = sumUpgradedInclusive(fromDateId, row.date_id)
      const paying = toMetricNumber(row.paying)
      const current_rate = toMetricNumber(row.upgrade_rate_12m)
      const next_rate = calculateUpgradeRate12m(upgraded_orgs_12m, paying)

      return {
        date_id: row.date_id,
        paying,
        upgraded_orgs_12m,
        current_rate,
        next_rate,
        changed: row.upgrade_rate_12m == null || hasRateChanged(current_rate, next_rate),
      }
    })
}

async function fetchGlobalStatsRows(supabase: SupabaseClient, fromDateId: string | null, toDateId: string | null) {
  const rows: GlobalStatsRow[] = []
  let offset = 0

  while (true) {
    let query = supabase
      .from('global_stats')
      .select('date_id, paying, upgrade_rate_12m, upgraded_orgs')
      .order('date_id', { ascending: true })
      .range(offset, offset + DEFAULT_PAGE_SIZE - 1)

    if (fromDateId)
      query = query.gte('date_id', fromDateId)
    if (toDateId)
      query = query.lte('date_id', toDateId)

    const { data, error } = await query
    if (error)
      throw error
    if (!data?.length)
      break

    rows.push(...data)
    if (data.length < DEFAULT_PAGE_SIZE)
      break
    offset += DEFAULT_PAGE_SIZE
  }

  return rows
}

async function fetchAllUpgradeRows(supabase: SupabaseClient) {
  // Need full history so trailing windows near --from still have prior days.
  return fetchGlobalStatsRows(supabase, null, null)
}

async function updateUpgradeRate(supabase: SupabaseClient, row: UpgradeRate12mBackfillRow) {
  const { error } = await supabase
    .from('global_stats')
    .update({ upgrade_rate_12m: row.next_rate })
    .eq('date_id', row.date_id)

  if (error)
    throw error
}

async function main(args = process.argv.slice(2), runtimeEnv: Record<string, string | undefined> = process.env) {
  const apply = args.includes('--apply')
  const all = args.includes('--all')
  const envFile = getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE
  const concurrency = parsePositiveInteger(getArgValue(args, '--concurrency'), '--concurrency', DEFAULT_CONCURRENCY)
  const fromDateId = all
    ? null
    : assertDateId(getArgValue(args, '--from') ?? getDefaultFromDateId(), '--from')
  const toDateId = all
    ? null
    : assertDateId(getArgValue(args, '--to') ?? getDateId(), '--to')

  if (fromDateId && toDateId && fromDateId > toDateId)
    throw new Error('--from must be before or equal to --to')

  const fileEnv = await loadEnv(envFile)
  const env = {
    ...fileEnv,
    ...runtimeEnv,
  }
  const supabase = createSupabaseServiceClient(env)

  const [targetRows, allUpgradeRows] = await Promise.all([
    fetchGlobalStatsRows(supabase, fromDateId, toDateId),
    fetchAllUpgradeRows(supabase),
  ])
  const backfillRows = buildUpgradeRate12mBackfillRows(targetRows, allUpgradeRows)
  const changedRows = backfillRows.filter(row => row.changed)

  console.log(`Loaded ${targetRows.length} target global_stats rows`)
  console.log(`Loaded ${allUpgradeRows.length} upgrade-history rows`)
  console.log(`Env file: ${envFile}`)
  if (all)
    console.log('Scope: all global_stats rows')
  else
    console.log(`Scope: ${fromDateId} to ${toDateId}`)
  console.log(`Rows needing update: ${changedRows.length}`)

  const sampleRows = changedRows.slice(0, 10)
  if (sampleRows.length > 0) {
    console.log('Sample updates:')
    for (const row of sampleRows)
      console.log(`${row.date_id}: ${row.current_rate}% -> ${row.next_rate}% (${row.upgraded_orgs_12m}/${row.paying} paying)`)
  }

  if (!apply) {
    console.log('Dry run only. Pass --apply to update global_stats.')
    return
  }

  if (changedRows.length === 0) {
    console.log('Nothing to update.')
    return
  }

  let updated = 0
  await asyncPool(concurrency, changedRows, async (row) => {
    await updateUpgradeRate(supabase, row)
    updated++
    if (updated % 100 === 0 || updated === changedRows.length)
      console.log(`Updated ${updated}/${changedRows.length}`)
  })

  console.log(`Done. Updated ${updated}/${changedRows.length} upgrade_rate_12m rows.`)
}

if (import.meta.main)
  await main()
