import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import { Hono } from 'hono/tiny'
import { middlewareAPISecret, parseBody, simpleError, useCors } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { isTransientDatabaseError } from '../utils/pg_errors.ts'
import { queryJson } from '../utils/pg_rls.ts'
import { getRetryablePostgrestStatus, isRetryablePostgrestError, isRetryablePostgrestResult, isRetryablePostgrestStatus, retryWithBackoff } from '../utils/retry.ts'
import { readStatsBandwidth, readStatsMau, readStatsVersion } from '../utils/stats.ts'

interface DataToGet {
  appId?: string
  orgId?: string
  todayOnly?: boolean
  currentHour?: string
}

export const app = new Hono<MiddlewareKeyVariables>()

const SUPABASE_RETRY_ATTEMPTS = 3
const SUPABASE_RETRY_DELAY_MS = 300

interface SupabaseRetryResult<T> {
  data: T | null
  error: unknown
  status?: number | null
}

interface CycleInfo {
  subscription_anchor_start: string | null
  subscription_anchor_end: string | null
}

interface AppOwnerOrgRow {
  owner_org: string
  /** apps.id: identifies this incarnation of the app ID. */
  id: string | null
  created_at: string | Date | null
  transfer_history: unknown[] | null
}

/** A former owner's ownership segment, which ended at a transfer away from it. */
interface FormerOwnerSegment {
  orgId: string
  /** When that org got the app (creation or transfer to it), null when unknown. */
  ownedSince: string | null
  transferredAt: string
}

interface StorageOwnership {
  /** apps.id loaded by the refresh; live writes are refused for another incarnation. */
  appUuid?: string | null
  /** transfer_history length loaded by the refresh; live writes are refused after a new transfer. */
  transferCount?: number | null
  /** When the current owner got the app: its creation or its last transfer to that org. */
  ownedSince: string | null
  /** Every earlier owner's segment, oldest first. */
  formerOwners: FormerOwnerSegment[]
}

interface CycleBoundsRow {
  cycle_start: string | null
  cycle_end: string | null
}

interface VersionNameRow {
  id: number
  name: string
}

interface VersionMetaStorageRow {
  timestamp: string | Date
  version_id: number
  size: number
}

interface StorageVersionLifetime {
  addedAt?: number
  removedAt?: number
  size?: number
}

interface StorageHourlyRow {
  app_id: string
  owner_org: string
  /** UTC date of the start of the billing cycle these hours belong to. */
  cycle_start: string
  date: string
  storage_byte_hours: number
  updated_at: string
}

interface StorageHourlyCalculationOptions {
  appId: string
  ownerOrg: string
  cycleStart: string
  cycleEnd: string
  currentHour?: string
  /** Hours before this instant belong to another owner (or an earlier app with this ID). */
  accrualStart?: string | null
  /** When the refresh started, before it read version_meta. Newer rows are never replaced. */
  writtenAt?: string
  /**
   * Live refreshes only write while `ownerOrg` still owns the app (default). The former-owner and
   * deletion finalizers write rows clipped at the transfer or deletion and turn it off.
   */
  requireCurrentOwner?: boolean
  /** apps.id the refresh loaded: a live write is refused once the app ID is another incarnation. */
  appUuid?: string | null
  /** transfer_history length the refresh loaded: a live write is refused after a new transfer. */
  transferCount?: number | null
}

interface StorageHourlyCalculationResult {
  rows: StorageHourlyRow[]
  skippedMissingAddition: number
  skippedInvalidInterval: number
}

type StorageIntervalSkipReason = 'missingAddition' | 'invalidInterval' | 'outsideCycle'

interface StorageInterval {
  start: number
  end: number
  size: number
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MAX_STORAGE_CYCLE_HOURS = 34 * 24

function parseTimestampMs(value: string | Date): number {
  const date = value instanceof Date ? value : new Date(value)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp))
    throw new Error(`Invalid timestamp: ${String(value)}`)
  return timestamp
}

// node-postgres returns timestamptz as Date: keep one string shape for the calculation options.
function toIsoTimestamp(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined)
    return null
  return new Date(value).toISOString()
}

function floorToDay(timestampMs: number): number {
  return Math.floor(timestampMs / DAY_MS) * DAY_MS
}

function formatUtcDay(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10)
}

function getStorageDailyDeleteRange(cycleStart: string, cycleEnd: string) {
  const cycleStartMs = parseTimestampMs(cycleStart)
  const cycleEndMs = parseTimestampMs(cycleEnd)
  const lastOverlappingDayMs = floorToDay(Math.max(cycleStartMs, cycleEndMs - 1))

  return {
    startDay: formatUtcDay(floorToDay(cycleStartMs)),
    endExclusiveDay: formatUtcDay(lastOverlappingDayMs + DAY_MS),
  }
}

function emptyStorageHourlyCalculationResult(): StorageHourlyCalculationResult {
  return {
    rows: [],
    skippedMissingAddition: 0,
    skippedInvalidInterval: 0,
  }
}

function assertStorageCycleWithinLimit(cycleStartMs: number, cycleEndMs: number) {
  const cycleHours = Math.ceil((cycleEndMs - cycleStartMs) / HOUR_MS)
  if (cycleHours > MAX_STORAGE_CYCLE_HOURS)
    throw new Error(`Billing cycle is too large for hourly storage calculation: ${cycleHours} hours`)
}

function applyStorageEvent(current: StorageVersionLifetime, event: VersionMetaStorageRow, timestamp: number) {
  if (event.size > 0) {
    if (current.addedAt === undefined || timestamp < current.addedAt) {
      current.addedAt = timestamp
      current.size = event.size
    }
    return
  }

  if (event.size < 0 && (current.removedAt === undefined || timestamp < current.removedAt))
    current.removedAt = timestamp
}

function collectStorageVersionLifetimes(events: VersionMetaStorageRow[]) {
  const versions = new Map<number, StorageVersionLifetime>()
  for (const event of events) {
    const timestamp = parseTimestampMs(event.timestamp)
    const current = versions.get(event.version_id) ?? {}
    applyStorageEvent(current, event, timestamp)
    versions.set(event.version_id, current)
  }
  return versions
}

function getStorageInterval(
  version: StorageVersionLifetime,
  cycleStartMs: number,
  calculationEndMs: number,
  cycleEndMs: number,
): StorageInterval | { skipReason: StorageIntervalSkipReason } {
  if (version.addedAt === undefined || version.size === undefined || version.size <= 0)
    return { skipReason: 'missingAddition' }

  const start = Math.max(version.addedAt, cycleStartMs)
  const end = Math.min(version.removedAt ?? calculationEndMs, calculationEndMs, cycleEndMs)
  if (end <= cycleStartMs || start >= calculationEndMs)
    return { skipReason: 'outsideCycle' }
  if (end <= start)
    return { skipReason: 'invalidInterval' }

  return { start, end, size: version.size }
}

function addStorageIntervalToDailyBuckets(dailyBuckets: Map<number, number>, interval: StorageInterval) {
  for (let bucketStart = floorToDay(interval.start); bucketStart < interval.end; bucketStart += DAY_MS) {
    const overlapStart = Math.max(bucketStart, interval.start)
    const overlapEnd = Math.min(bucketStart + DAY_MS, interval.end)
    if (overlapEnd <= overlapStart)
      continue

    const byteHours = interval.size * ((overlapEnd - overlapStart) / HOUR_MS)
    dailyBuckets.set(bucketStart, (dailyBuckets.get(bucketStart) ?? 0) + byteHours)
  }
}

function buildStorageHourlyRows(dailyBuckets: Map<number, number>, options: StorageHourlyCalculationOptions) {
  const now = options.writtenAt ?? new Date().toISOString()
  return Array.from(dailyBuckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([dateMs, storageByteHours]) => ({
      app_id: options.appId,
      owner_org: options.ownerOrg,
      cycle_start: formatUtcDay(floorToDay(parseTimestampMs(options.cycleStart))),
      date: formatUtcDay(dateMs),
      storage_byte_hours: storageByteHours,
      updated_at: now,
    }))
}

export function calculateStorageHourlyRows(
  events: VersionMetaStorageRow[],
  options: StorageHourlyCalculationOptions,
): StorageHourlyCalculationResult {
  const cycleStartMs = parseTimestampMs(options.cycleStart)
  const cycleEndMs = parseTimestampMs(options.cycleEnd)
  const currentHourMs = options.currentHour ? parseTimestampMs(options.currentHour) : Date.now()
  const calculationEndMs = Math.min(cycleEndMs, currentHourMs)
  // Rows stay tagged with the cycle start; only the accrued window is clipped to the owner.
  const windowStartMs = options.accrualStart ? Math.max(cycleStartMs, parseTimestampMs(options.accrualStart)) : cycleStartMs

  if (calculationEndMs <= windowStartMs)
    return emptyStorageHourlyCalculationResult()

  assertStorageCycleWithinLimit(cycleStartMs, cycleEndMs)
  const versions = collectStorageVersionLifetimes(events)
  const dailyBuckets = new Map<number, number>()
  let skippedMissingAddition = 0
  let skippedInvalidInterval = 0

  for (const version of versions.values()) {
    const interval = getStorageInterval(version, windowStartMs, calculationEndMs, cycleEndMs)
    if ('skipReason' in interval) {
      if (interval.skipReason === 'missingAddition')
        skippedMissingAddition++
      else if (interval.skipReason === 'invalidInterval')
        skippedInvalidInterval++
      continue
    }

    addStorageIntervalToDailyBuckets(dailyBuckets, interval)
  }

  return {
    rows: buildStorageHourlyRows(dailyBuckets, options),
    skippedMissingAddition,
    skippedInvalidInterval,
  }
}

async function runSupabaseResultWithRetry<T>(
  c: Context,
  label: string,
  operation: () => Promise<SupabaseRetryResult<T>>,
): Promise<SupabaseRetryResult<T>> {
  const { result, attempts } = await retryWithBackoff(async () => {
    try {
      return await operation()
    }
    catch (error) {
      return {
        data: null,
        error,
      }
    }
  }, {
    attempts: SUPABASE_RETRY_ATTEMPTS,
    baseDelayMs: SUPABASE_RETRY_DELAY_MS,
    shouldRetry: result => isRetryablePostgrestResult(result) || isTransientDatabaseError(result?.error),
  })

  if (!result) {
    throw new Error(`${label} returned no result`)
  }

  if (attempts > 1) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'cron_stat_app retry finished',
      label,
      attempts,
      hadError: Boolean(result.error || isRetryablePostgrestStatus(getRetryablePostgrestStatus(result))),
    })
  }

  if (result.error) {
    throw result.error
  }

  if (typeof result.status === 'number' && result.status >= 400) {
    throw new Error(`${label} failed with status ${result.status}`)
  }

  return result
}

async function readVersionMetaStorageRows(pg: PgClient, appId: string, calculationEnd: string) {
  const { rows } = await pg.query<VersionMetaStorageRow>(
    `
      SELECT timestamp, version_id, size
      FROM public.version_meta
      WHERE app_id = $1
        AND timestamp < $2::timestamp
      ORDER BY version_id, timestamp
    `,
    [appId, calculationEnd],
  )
  return rows
}

// Same as a PostgREST bulk upsert: missing keys become NULL and only the listed
// columns are written. Table, column and conflict names are fixed by callers.
async function upsertRows(
  pg: PgClient,
  table: string,
  columns: Record<string, string>,
  conflictColumns: string[],
  rows: object[],
) {
  if (rows.length === 0)
    return
  const names = Object.keys(columns)
  const recordset = names.map(name => `"${name}" ${columns[name]}`).join(', ')
  const updates = names.filter(name => !conflictColumns.includes(name)).map(name => `"${name}" = EXCLUDED."${name}"`).join(', ')
  await pg.query(
    `INSERT INTO public.${table} (${names.map(name => `"${name}"`).join(', ')})
    SELECT ${names.map(name => `r."${name}"`).join(', ')} FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(${recordset})
    ON CONFLICT (${conflictColumns.map(name => `"${name}"`).join(', ')}) DO UPDATE SET ${updates}`,
    [JSON.stringify(rows)],
  )
}

// Former owners are finalized for transfers in this window. An older transfer's billing periods
// are long closed, so its owner is not recomputed on every refresh.
const FORMER_OWNER_LOOKBACK_MS = 100 * DAY_MS

/**
 * Key of an ownership segment in daily_storage_hourly and its watermark: when the owner got the
 * app (creation or transfer), '-infinity' when unknown (like rows written before segments). It does
 * not depend on the cycle, so a moved anchor keeps the same segment.
 */
function storageSegmentKey(ownedSince: string | null | undefined): string {
  return ownedSince ?? '-infinity'
}

/** The billing cycle of `orgId` that contains the instant just before `before`. */
async function readCycleBefore(pg: PgClient, orgId: string, before: string): Promise<CycleBoundsRow | null> {
  const { rows } = await pg.query<CycleBoundsRow>(
    `SELECT cycle.cycle_start, cycle.cycle_end
     FROM public.orgs o
     LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
     CROSS JOIN LATERAL public.billing_cycle_for_anchor(
       si.subscription_anchor_start,
       si.subscription_anchor_end,
       $2::timestamptz - interval '1 second'
     ) AS cycle
     WHERE o.id = $1::uuid
     LIMIT 1`,
    [orgId, before],
  )
  return rows[0] ?? null
}

async function replaceCycleStorageHourly(
  c: Context,
  pg: PgClient,
  events: VersionMetaStorageRow[],
  options: StorageHourlyCalculationOptions,
) {
  const calculation = calculateStorageHourlyRows(events, options)

  if (calculation.skippedMissingAddition > 0 || calculation.skippedInvalidInterval > 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'storage hourly skipped invalid version metadata',
      appId: options.appId,
      skippedMissingAddition: calculation.skippedMissingAddition,
      skippedInvalidInterval: calculation.skippedInvalidInterval,
    })
  }

  const deleteRange = getStorageDailyDeleteRange(options.cycleStart, options.cycleEnd)
  const cycleEndDay = formatUtcDay(floorToDay(parseTimestampMs(options.cycleEnd)))
  const writtenAt = options.writtenAt ?? new Date().toISOString()
  // replace_app_storage_hourly replaces only this org's rows of this cycle and ownership segment, in
  // one statement, and never a row written by a refresh that started after writtenAt.
  await runSupabaseResultWithRetry(c, 'replace_daily_storage_hourly', async () => {
    await pg.query(
      `SELECT public.replace_app_storage_hourly(
         p_app_id => $1::varchar,
         p_owner_org => $2::uuid,
         p_cycle_start_day => $3::date,
         p_cycle_end_day => $4::date,
         p_end_exclusive_day => $5::date,
         p_segment_start => $6::timestamptz,
         p_rows => $7::jsonb,
         p_written_at => $8::timestamptz,
         p_require_current_owner => $9::boolean,
         p_app_uuid => $10::uuid,
         p_calculated_until => $11::timestamptz,
         p_transfer_count => $12::integer
       )`,
      [
        options.appId,
        options.ownerOrg,
        deleteRange.startDay,
        cycleEndDay,
        deleteRange.endExclusiveDay,
        storageSegmentKey(options.accrualStart),
        JSON.stringify(calculation.rows.map(row => ({ cycle_start: row.cycle_start, date: row.date, storage_byte_hours: row.storage_byte_hours }))),
        writtenAt,
        options.requireCurrentOwner ?? true,
        options.appUuid ?? null,
        // How far this calculation went: the finalization checks compare against it.
        new Date(Math.min(parseTimestampMs(options.cycleEnd), options.currentHour ? parseTimestampMs(options.currentHour) : parseTimestampMs(writtenAt))).toISOString(),
        options.transferCount ?? null,
      ],
    )
    return { data: null, error: null }
  })

  return calculation
}

/** How far the latest refresh of an app/org/cycle/segment calculated, if any. */
async function readStorageRefreshedAt(pg: PgClient, appId: string, ownerOrg: string, cycleStartDay: string, segmentStart: string) {
  const { rows } = await pg.query<{ calculated_until: string | Date | null }>(
    `SELECT calculated_until
     FROM public.daily_storage_hourly_refreshes
     WHERE app_id = $1
       AND owner_org = $2::uuid
       AND cycle_start = $3::date
       AND segment_start = $4::timestamptz`,
    [appId, ownerOrg, cycleStartDay, segmentStart],
  )
  return toIsoTimestamp(rows[0]?.calculated_until)
}

async function readSegmentRefreshedAt(c: Context, pg: PgClient, appId: string, ownerOrg: string, cycleStart: string, ownedSince: string | null) {
  return (await runSupabaseResultWithRetry<string | null>(c, 'read_storage_refresh', async () => ({
    data: await readStorageRefreshedAt(pg, appId, ownerOrg, formatUtcDay(floorToDay(parseTimestampMs(cycleStart))), storageSegmentKey(ownedSince)),
    error: null,
  }))).data
}

// Earlier cycles walked back when refreshes were missing across several rollovers (about the same
// window as the former-owner lookback).
const MAX_UNFINISHED_PREVIOUS_CYCLES = 3

/**
 * Records the previous cycles' hours up to their end until a refresh that calculated past that end
 * has done it (its watermark): the interval between a cycle's last refresh and its rollover is only
 * recorded then, however late the next refresh comes. Walks back through consecutive unfinished
 * cycles (a gap across several rollovers), stopping at the first finalized one. Used by live
 * refreshes, the deletion finalizer and the former-owner finalizer.
 */
async function finalizePreviousCycle(
  c: Context,
  pg: PgClient,
  events: VersionMetaStorageRow[],
  options: { appId: string, ownerOrg: string, cycleStart: string, calculationEndMs: number, accrualStart: string | null, writtenAt: string, requireCurrentOwner?: boolean, appUuid?: string | null, transferCount?: number | null },
) {
  let laterCycleStart = options.cycleStart
  for (let walked = 0; walked < MAX_UNFINISHED_PREVIOUS_CYCLES; walked++) {
    const laterCycleStartMs = parseTimestampMs(laterCycleStart)
    const previous = (await runSupabaseResultWithRetry<CycleBoundsRow | null>(c, 'read_previous_storage_cycle', async () => ({
      data: await readCycleBefore(pg, options.ownerOrg, laterCycleStart),
      error: null,
    }))).data
    // Only a previous cycle that ends exactly where the later one starts (a plan change can move the anchor).
    if (!previous?.cycle_start || !previous.cycle_end || parseTimestampMs(previous.cycle_end) !== laterCycleStartMs)
      return
    const previousEndMs = parseTimestampMs(previous.cycle_end)
    // Nothing of that cycle (or any earlier one) is owned by this segment.
    if (options.accrualStart && parseTimestampMs(options.accrualStart) >= previousEndMs)
      return
    const finalizedAt = await readSegmentRefreshedAt(c, pg, options.appId, options.ownerOrg, previous.cycle_start, options.accrualStart)
    if (finalizedAt && parseTimestampMs(finalizedAt) >= previousEndMs)
      return
    await replaceCycleStorageHourly(c, pg, events, {
      appId: options.appId,
      ownerOrg: options.ownerOrg,
      cycleStart: previous.cycle_start,
      cycleEnd: previous.cycle_end,
      // Never past the calculation's own end (a backfill with an earlier currentHour).
      currentHour: new Date(Math.min(previousEndMs, options.calculationEndMs)).toISOString(),
      accrualStart: options.accrualStart,
      writtenAt: options.writtenAt,
      requireCurrentOwner: options.requireCurrentOwner,
      appUuid: options.appUuid,
      transferCount: options.transferCount,
    })
    laterCycleStart = previous.cycle_start
  }
}

/**
 * After a transfer, the former owner's refreshes stop: records its hours from its last refresh up
 * to the transfer, in its billing cycle that contains it (and the previous one after a rollover),
 * once: until a refresh of that segment started after the transfer. Runs for every former owner in
 * the transfer history (A to B to C finalizes A and B), from live refreshes and from the deletion
 * finalizer.
 */
async function finalizeFormerOwners(
  c: Context,
  pg: PgClient,
  events: VersionMetaStorageRow[],
  options: { appId: string, formerOwners: FormerOwnerSegment[], calculationEndMs: number, writtenAt: string },
) {
  for (const former of options.formerOwners) {
    const transferredAtMs = parseTimestampMs(former.transferredAt)
    if (transferredAtMs > options.calculationEndMs || options.calculationEndMs - transferredAtMs > FORMER_OWNER_LOOKBACK_MS)
      continue
    const formerCycle = (await runSupabaseResultWithRetry<CycleBoundsRow | null>(c, 'read_former_owner_cycle', async () => ({
      data: await readCycleBefore(pg, former.orgId, former.transferredAt),
      error: null,
    }))).data
    if (!formerCycle?.cycle_start || !formerCycle.cycle_end)
      continue
    const finalizedAt = await readSegmentRefreshedAt(c, pg, options.appId, former.orgId, formerCycle.cycle_start, former.ownedSince)
    if (finalizedAt && parseTimestampMs(finalizedAt) >= transferredAtMs)
      continue
    // The previous cycle runs first: the transfer cycle's replace advances the watermark checked
    // above, so finalization only counts as done once both cycles succeeded.
    await finalizePreviousCycle(c, pg, events, {
      appId: options.appId,
      ownerOrg: former.orgId,
      cycleStart: formerCycle.cycle_start,
      calculationEndMs: transferredAtMs,
      accrualStart: former.ownedSince,
      writtenAt: options.writtenAt,
      requireCurrentOwner: false,
    })
    await replaceCycleStorageHourly(c, pg, events, {
      appId: options.appId,
      ownerOrg: former.orgId,
      cycleStart: formerCycle.cycle_start,
      cycleEnd: formerCycle.cycle_end,
      currentHour: former.transferredAt,
      accrualStart: former.ownedSince,
      writtenAt: options.writtenAt,
      requireCurrentOwner: false,
    })
  }
}

async function refreshStorageHourly(
  c: Context,
  pg: PgClient,
  appId: string,
  ownerOrg: string,
  cycleInfo: CycleInfo,
  currentHour?: string,
  ownership: StorageOwnership = { ownedSince: null, formerOwners: [] },
) {
  if (!cycleInfo.subscription_anchor_start || !cycleInfo.subscription_anchor_end)
    throw simpleError('cannot_get_cycle_info', 'Cannot get cycle info', { cycleInfo })

  // Taken before reading version_meta, so a refresh that finishes late never replaces the rows
  // of a refresh that started after it.
  const writtenAt = new Date().toISOString()
  const calculationEnd = currentHour ?? writtenAt
  const calculationEndMs = parseTimestampMs(calculationEnd)
  const events = await readVersionMetaStorageRows(pg, appId, calculationEnd)
  const cycleStart = cycleInfo.subscription_anchor_start
  const calculation = await replaceCycleStorageHourly(c, pg, events, {
    appId,
    ownerOrg,
    cycleStart,
    cycleEnd: cycleInfo.subscription_anchor_end,
    currentHour: calculationEnd,
    accrualStart: ownership.ownedSince,
    writtenAt,
    appUuid: ownership.appUuid,
    transferCount: ownership.transferCount,
  })

  await finalizePreviousCycle(c, pg, events, {
    appId,
    ownerOrg,
    cycleStart,
    calculationEndMs,
    accrualStart: ownership.ownedSince,
    writtenAt,
    appUuid: ownership.appUuid,
    transferCount: ownership.transferCount,
  })

  await finalizeFormerOwners(c, pg, events, { appId, formerOwners: ownership.formerOwners, calculationEndMs, writtenAt })

  return calculation
}

interface AppOwnershipRecord {
  owner_org: string | null
  created_at?: string | Date | null
  transfer_history?: unknown[] | null
}

interface DeletedAppRecord extends AppOwnershipRecord {
  app_id: string
}

interface TransferEntry {
  transferred_at?: string
  transferred_from?: string
  transferred_to?: string
}

/**
 * Ownership segments of an app from its creation and transfer history: the current owner's start,
 * and every former owner's segment (from when it got the app to its transfer away), oldest first.
 */
export function appStorageOwnership(record: AppOwnershipRecord): StorageOwnership {
  const createdMs = record.created_at ? parseTimestampMs(record.created_at) : null
  const transfers = (record.transfer_history ?? [])
    .map(entry => entry as TransferEntry | null)
    .filter((entry): entry is Required<TransferEntry> => !!entry?.transferred_at && !!entry.transferred_from && !!entry.transferred_to)
    .map(entry => ({ at: parseTimestampMs(entry.transferred_at), from: entry.transferred_from, to: entry.transferred_to }))
    .filter(entry => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at)

  // When `orgId` got the app for the segment ending at `untilMs`.
  const ownedSinceFor = (orgId: string, untilMs: number) => {
    let since = createdMs
    for (const transfer of transfers) {
      if (transfer.to === orgId && transfer.at < untilMs)
        since = since === null ? transfer.at : Math.max(since, transfer.at)
    }
    return since === null ? null : new Date(since).toISOString()
  }

  return {
    ownedSince: record.owner_org ? ownedSinceFor(record.owner_org, Number.POSITIVE_INFINITY) : null,
    formerOwners: transfers.map(transfer => ({
      orgId: transfer.from,
      ownedSince: ownedSinceFor(transfer.from, transfer.at),
      transferredAt: new Date(transfer.at).toISOString(),
    })),
  }
}

/**
 * When the app was deleted: close_app_storage_lifetimes closes every open bundle lifetime at the
 * deletion, so the latest closing event is the deletion time. Falls back to `fallback` (the
 * handler's clock) when the app had no bundle to close.
 */
async function readAppDeletedAt(pg: PgClient, appId: string, fallback: string): Promise<string> {
  const { rows } = await pg.query<{ deleted_at: string | Date | null }>(
    `SELECT max(timestamp) AS deleted_at
     FROM public.version_meta
     WHERE app_id = $1
       AND size < 0
       AND timestamp <= $2::timestamp`,
    [appId, fallback],
  )
  return toIsoTimestamp(rows[0]?.deleted_at) ?? fallback
}

/**
 * Records a deleted app's storage hours from its last refresh up to the deletion, in its owner's
 * billing cycle: cron_stat_app skips apps that no longer exist, so that interval would be lost.
 */
export async function finalizeDeletedAppStorageHourly(
  c: Context,
  pg: PgClient,
  record: DeletedAppRecord,
  processedAt: string,
  occurredAt?: string | null,
) {
  if (!record.owner_org)
    return null
  const writtenAt = new Date().toISOString()
  // The trigger event's time is the deletion. Older messages have none: fall back to the latest
  // lifetime closed by close_app_storage_lifetimes.
  const deletedAt = occurredAt ?? await readAppDeletedAt(pg, record.app_id, processedAt)
  const deletedAtMs = parseTimestampMs(deletedAt)
  // Only events up to the deletion: a recreated app ID's events belong to the new incarnation.
  const events = await readVersionMetaStorageRows(pg, record.app_id, new Date(deletedAtMs + 1).toISOString())
  const cycle = await readCycleBefore(pg, record.owner_org, deletedAt)
  if (!cycle?.cycle_start || !cycle.cycle_end)
    return null
  const ownership = appStorageOwnership(record)
  const calculation = await replaceCycleStorageHourly(c, pg, events, {
    appId: record.app_id,
    ownerOrg: record.owner_org,
    cycleStart: cycle.cycle_start,
    cycleEnd: cycle.cycle_end,
    currentHour: deletedAt,
    accrualStart: ownership.ownedSince,
    writtenAt,
    // The app row is gone: these rows are clipped at the deletion.
    requireCurrentOwner: false,
  })
  // Deleted after a rollover the previous cycle was not finalized for yet.
  await finalizePreviousCycle(c, pg, events, {
    appId: record.app_id,
    ownerOrg: record.owner_org,
    cycleStart: cycle.cycle_start,
    calculationEndMs: deletedAtMs,
    accrualStart: ownership.ownedSince,
    writtenAt,
    requireCurrentOwner: false,
  })
  // Deleted after transfers whose former owners were not finalized yet.
  await finalizeFormerOwners(c, pg, events, { appId: record.app_id, formerOwners: ownership.formerOwners, calculationEndMs: deletedAtMs, writtenAt })
  return calculation
}

async function syncAppStatsRefresh(
  c: Context,
  pg: PgClient,
  appId: string,
): Promise<string> {
  const { data } = await runSupabaseResultWithRetry<string | null>(c, 'sync_app_stats_refresh', async () => {
    const result = await pg.query<{ refreshed_at: string | null }>(
      'SELECT pg_catalog.to_json(public.mark_app_stats_refreshed(p_app_id => $1)) AS refreshed_at',
      [appId],
    )
    return { data: result.rows[0]?.refreshed_at ?? null, error: null }
  })

  if (!data) {
    throw new Error('sync_app_stats_refresh returned no timestamp')
  }

  return data
}

app.use('/', useCors)

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<DataToGet>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post cron_stat_app body', body })
  if (!body.appId)
    throw simpleError('no_appId', 'No appId', { body })
  if (!body.orgId)
    throw simpleError('no_orgId', 'No orgId', { body })
  const appId = body.appId
  const orgId = body.orgId

  const pg = await getPgClient(c)
  try {
    return await saveAppStats(c, pg, body, appId, orgId)
  }
  finally {
    closeClient(c, pg)
  }
})

async function saveAppStats(c: Context, pg: PgClient, body: DataToGet, appId: string, orgId: string) {
  const appResult = await runSupabaseResultWithRetry<AppOwnerOrgRow>(c, 'load_app', async () => {
    const result = await pg.query<AppOwnerOrgRow>(
      `SELECT apps.owner_org, apps.id, apps.created_at, pg_catalog.to_jsonb(apps.transfer_history) AS transfer_history
       FROM public.apps
       WHERE apps.app_id = $1
       LIMIT 2`,
      [appId],
    )
    if (result.rows.length > 1)
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    return { data: result.rows[0] ?? null, error: null }
  })
  if (!appResult.data) {
    cloudlog({ requestId: c.get('requestId'), message: 'cron_stat_app skipping missing app', body })
    return c.json({ status: 'skipped', reason: 'app_not_found' })
  }
  if (appResult.data.owner_org !== orgId) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'cron_stat_app skipping owner mismatch',
      body,
      app_owner_org: appResult.data.owner_org,
    })
    return c.json({ status: 'skipped', reason: 'owner_org_mismatch' })
  }

  // get the period of the billing of the organization
  const cycleInfoResult = await runSupabaseResultWithRetry<CycleInfo>(c, 'get_cycle_info_org', async () => {
    const rows = await queryJson<CycleInfo>(pg, 'SELECT * FROM public.get_cycle_info_org(orgid => $1)', [orgId])
    if (rows.length !== 1)
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    return { data: rows[0], error: null }
  })
  const cycleInfo = cycleInfoResult.data
  if (!cycleInfo?.subscription_anchor_start || !cycleInfo?.subscription_anchor_end)
    throw simpleError('cannot_get_cycle_info', 'Cannot get cycle info', { cycleInfoResult })

  cloudlog({ requestId: c.get('requestId'), message: 'cycleInfo', cycleInfo })
  const startDate = cycleInfo.subscription_anchor_start
  const endDate = cycleInfo.subscription_anchor_end

  // get mau
  let mau = await readStatsMau(c, appId, startDate, endDate)
  // get bandwidth
  let bandwidth = await readStatsBandwidth(c, appId, startDate, endDate)
  let versionUsage = await readStatsVersion(c, appId, startDate, endDate)

  if (body.todayOnly) {
    // take only the last day
    mau = mau.slice(-1)
    bandwidth = bandwidth.slice(-1)
    // version usage has one row per (date, version): keep every version of the last day
    const lastVersionDate = versionUsage.at(-1)?.date
    versionUsage = versionUsage.filter(v => v.date === lastVersionDate)
  }

  // Handle backwards compatibility: old Cloudflare data has numeric version_id in blob2,
  // new data has version_name string. Detect and resolve old data.
  const versionNamesToResolve = versionUsage
    .filter(v => /^\d+$/.test(String(v.version_name)))
    .map(v => Number(v.version_name))

  let versionIdToNameMap: Record<number, string> = {}
  if (versionNamesToResolve.length > 0) {
    // Only resolve ids of this app's bundles, and never rewrite a value that is also
    // a real bundle name of this app (bundles can be named "123").
    const [{ data: versions }, { data: numericNamedVersions }] = await Promise.all([
      runSupabaseResultWithRetry<VersionNameRow[]>(c, 'resolve_version_names', async () => ({
        data: await queryJson<VersionNameRow>(pg, 'SELECT id, name FROM public.app_versions WHERE app_id = $1 AND id = ANY($2::bigint[])', [appId, versionNamesToResolve]),
        error: null,
      })),
      runSupabaseResultWithRetry<VersionNameRow[]>(c, 'resolve_numeric_version_names', async () => ({
        data: await queryJson<VersionNameRow>(pg, 'SELECT id, name FROM public.app_versions WHERE app_id = $1 AND name = ANY($2::varchar[])', [appId, versionNamesToResolve.map(String)]),
        error: null,
      })),
    ])
    const realNumericNames = new Set((numericNamedVersions ?? []).map(v => v.name))
    if (versions) {
      versionIdToNameMap = Object.fromEntries(versions
        .filter(v => !realNumericNames.has(String(v.id)))
        .map(v => [v.id, v.name]))
    }
  }

  // Map version_name for old data (numeric version_id -> actual version name)
  const mappedVersionUsage = versionUsage.map((v) => {
    const versionNameOrId = String(v.version_name)
    if (/^\d+$/.test(versionNameOrId)) {
      // Old data: resolve version_id to version_name
      const resolvedName = versionIdToNameMap[Number(versionNameOrId)]
      return { ...v, version_name: resolvedName || versionNameOrId }
    }
    return v
  })

  // Aggregate entries with same (app_id, date, version_name) after mapping
  // This handles the transition period where old (version_id) and new (version_name) data coexist
  const aggregationMap = new Map<string, typeof mappedVersionUsage[0]>()
  for (const entry of mappedVersionUsage) {
    const key = `${entry.app_id}|${entry.date}|${entry.version_name}`
    const existing = aggregationMap.get(key)
    if (existing) {
      // Aggregate stats
      existing.get += entry.get
      existing.fail += entry.fail
      existing.install += entry.install
      existing.uninstall += entry.uninstall
    }
    else {
      // Clone to avoid mutating original
      aggregationMap.set(key, { ...entry })
    }
  }
  const resolvedVersionUsage = Array.from(aggregationMap.values())

  cloudlog({ requestId: c.get('requestId'), message: 'mau', mauLength: mau.length, mauCount: mau.reduce((acc, curr) => acc + curr.mau, 0), mau: JSON.stringify(mau) })
  cloudlog({ requestId: c.get('requestId'), message: 'bandwidth', bandwidthLength: bandwidth.length, bandwidthCount: bandwidth.reduce((acc, curr) => acc + curr.bandwidth, 0), bandwidth: JSON.stringify(bandwidth) })
  cloudlog({ requestId: c.get('requestId'), message: 'versionUsage', versionUsageLength: resolvedVersionUsage.length, versionUsageCount: resolvedVersionUsage.reduce((acc, curr) => acc + curr.get + curr.fail + curr.install + curr.uninstall, 0), versionUsage: JSON.stringify(resolvedVersionUsage) })

  // save to daily_mau, daily_bandwidth and daily_version
  // Note: daily_version upsert uses type cast because auto-generated types are stale
  // (migration adds version_name column but types haven't been regenerated)
  await Promise.all([
    runSupabaseResultWithRetry(c, 'upsert_daily_mau', async () => {
      await upsertRows(pg, 'daily_mau', { app_id: 'varchar', date: 'date', mau: 'bigint' }, ['app_id', 'date'], mau)
      return { data: null, error: null }
    }),
    runSupabaseResultWithRetry(c, 'upsert_daily_bandwidth', async () => {
      await upsertRows(pg, 'daily_bandwidth', { app_id: 'varchar', date: 'date', bandwidth: 'bigint' }, ['app_id', 'date'], bandwidth)
      return { data: null, error: null }
    }),
    runSupabaseResultWithRetry(c, 'upsert_daily_version', async () => {
      await upsertRows(pg, 'daily_version', {
        app_id: 'varchar',
        date: 'date',
        version_name: 'varchar',
        get: 'bigint',
        fail: 'bigint',
        install: 'bigint',
        uninstall: 'bigint',
      }, ['app_id', 'date', 'version_name'], resolvedVersionUsage)
      return { data: null, error: null }
    }),
  ])

  // Storage is billed from these byte-hours: a failure must fail the job so the
  // queue retries it, instead of leaving the cycle under-counted.
  const storageHourly = await refreshStorageHourly(c, pg, appId, orgId, cycleInfo, body.currentHour, {
    appUuid: appResult.data.id,
    transferCount: appResult.data.transfer_history?.length ?? 0,
    ...appStorageOwnership(appResult.data),
  })

  cloudlog({ requestId: c.get('requestId'), message: 'stats saved', mauLength: mau.length, bandwidthLength: bandwidth.length, storageHourlyLength: storageHourly.rows.length, versionUsageLength: versionUsage.length })
  await syncAppStatsRefresh(c, pg, appId)

  return c.json({ status: 'Stats saved', mau, bandwidth, storageHourly, versionUsage })
}

export const cronStatAppTestUtils = {
  isRetryablePostgrestError,
  runSupabaseResultWithRetry,
}
