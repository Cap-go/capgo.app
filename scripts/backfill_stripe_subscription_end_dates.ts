/*
 * Backfill Stripe subscription end dates into public.stripe_info.canceled_at.
 *
 * Dry run for rows missing canceled_at:
 *   bun run stripe:backfill-subscription-end-dates
 *
 * Apply missing end dates:
 *   bun run stripe:backfill-subscription-end-dates --apply
 *
 * Refresh existing end dates and billing anchors too:
 *   bun run stripe:backfill-subscription-end-dates --apply --refresh-existing
 */
import type Stripe from 'stripe'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import type pg from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { asyncPool, connectAdminDb, createStripeClient, DEFAULT_ENV_FILE, getArgValue, getRequiredEnv, isActionableStripeCustomerId, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const DEFAULT_CONCURRENCY = 8
const DEFAULT_PAGE_SIZE = 1000
const FAILURE_OUTPUT = './tmp/stripe_subscription_end_date_backfill_failures.json'

type StripeInfoSubscriptionEndRow = Pick<
  Database['public']['Tables']['stripe_info']['Row'],
  'canceled_at' | 'customer_id' | 'subscription_anchor_end' | 'subscription_anchor_start' | 'subscription_id'
>

export interface StripeSubscriptionEndBackfillCandidate {
  current_anchor_end: string | null
  current_anchor_start: string | null
  current_canceled_at: string | null
  customer_id: string
  next_anchor_end: string | null
  next_anchor_start: string | null
  next_canceled_at: string | null
  subscription_id: string
}

interface BackfillFailure {
  error: string
  subscriptionId: string | null
  customerId: string
}

function toIsoFromSeconds(seconds: number | null | undefined) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds))
    return null
  return new Date(seconds * 1000).toISOString()
}

function getLicensedSubscriptionItem(subscription: Stripe.Subscription) {
  return subscription.items.data.find(item => item.plan?.usage_type === 'licensed') ?? subscription.items.data[0] ?? null
}

export function getStripeSubscriptionEndSnapshot(subscription: Stripe.Subscription) {
  const item = getLicensedSubscriptionItem(subscription)
  const anchorStart = toIsoFromSeconds(item?.current_period_start)
  const anchorEnd = toIsoFromSeconds(item?.current_period_end)
  const itemPeriodEnd = typeof item?.current_period_end === 'number' ? item.current_period_end : null
  const endedAtSeconds = subscription.ended_at
    ?? subscription.cancel_at
    ?? (subscription.cancel_at_period_end ? itemPeriodEnd : null)

  return {
    subscription_anchor_start: anchorStart,
    subscription_anchor_end: anchorEnd,
    canceled_at: toIsoFromSeconds(endedAtSeconds),
  }
}

function normalizeIso(value: string | null | undefined) {
  if (!value)
    return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()))
    return null
  return parsed.toISOString()
}

function hasSnapshotChanged(row: StripeInfoSubscriptionEndRow, snapshot: ReturnType<typeof getStripeSubscriptionEndSnapshot>, refreshExisting: boolean) {
  const canceledAtChanged = normalizeIso(row.canceled_at) !== snapshot.canceled_at
  const anchorsChanged = normalizeIso(row.subscription_anchor_start) !== snapshot.subscription_anchor_start
    || normalizeIso(row.subscription_anchor_end) !== snapshot.subscription_anchor_end

  if (refreshExisting)
    return canceledAtChanged || anchorsChanged

  return !row.canceled_at && !!snapshot.canceled_at
}

async function fetchStripeInfoRows(
  db: pg.Pool,
  options: {
    customerId?: string | null
    missingOnly: boolean
  },
) {
  const rows: StripeInfoSubscriptionEndRow[] = []
  let lastSeenCustomerId: string | null = null

  while (true) {
    const { rows: data }: { rows: StripeInfoSubscriptionEndRow[] } = await db.query<StripeInfoSubscriptionEndRow>(
      `SELECT customer_id, subscription_id, subscription_anchor_start, subscription_anchor_end, canceled_at
       FROM public.stripe_info
       WHERE subscription_id IS NOT NULL
         AND ($1::text IS NULL OR customer_id = $1) AND ($2::text IS NULL OR customer_id > $2)
         AND (NOT $3::boolean OR canceled_at IS NULL)
       ORDER BY customer_id ASC
       LIMIT $4`,
      [options.customerId ?? null, lastSeenCustomerId, options.missingOnly, DEFAULT_PAGE_SIZE],
    )
    if (!data.length)
      break

    rows.push(...data)

    if (options.customerId || data.length < DEFAULT_PAGE_SIZE)
      break
    lastSeenCustomerId = data.at(-1)?.customer_id ?? null
  }

  return rows
}

async function updateSubscriptionEndSnapshot(db: pg.Pool, candidate: StripeSubscriptionEndBackfillCandidate) {
  // Anchors are only overwritten when Stripe returned one.
  await db.query(
    `UPDATE public.stripe_info
     SET canceled_at = $1,
         subscription_anchor_start = COALESCE($2, subscription_anchor_start),
         subscription_anchor_end = COALESCE($3, subscription_anchor_end)
     WHERE customer_id = $4`,
    [candidate.next_canceled_at, candidate.next_anchor_start || null, candidate.next_anchor_end || null, candidate.customer_id],
  )
}

async function writeFailures(failures: BackfillFailure[]) {
  if (failures.length === 0)
    return

  await mkdir('./tmp', { recursive: true })
  await writeFile(FAILURE_OUTPUT, `${JSON.stringify(failures, null, 2)}\n`)
  console.log(`Failure details written to ${FAILURE_OUTPUT}`)
}

async function main(args = process.argv.slice(2), runtimeEnv: Record<string, string | undefined> = process.env) {
  const apply = args.includes('--apply')
  const refreshExisting = args.includes('--refresh-existing')
  const envFile = getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE
  const customerId = getArgValue(args, '--customer-id')
  const limitArg = getArgValue(args, '--limit')
  const limit = limitArg ? parsePositiveInteger(limitArg, '--limit', 0) : null
  const concurrency = parsePositiveInteger(getArgValue(args, '--concurrency'), '--concurrency', DEFAULT_CONCURRENCY)

  const fileEnv = await loadEnv(envFile)
  const env = {
    ...fileEnv,
    ...runtimeEnv,
  }

  const stripe = createStripeClient(
    getRequiredEnv(env, 'STRIPE_SECRET_KEY'),
    env.STRIPE_API_BASE_URL?.trim(),
  )
  const db = await connectAdminDb(env)
  try {
    await backfill(db, stripe, { apply, concurrency, customerId, envFile, limit, refreshExisting })
  }
  finally {
    await db.end()
  }
}

interface BackfillOptions {
  apply: boolean
  concurrency: number
  customerId: string | null
  envFile: string
  limit: number | null
  refreshExisting: boolean
}

async function backfill(db: pg.Pool, stripe: ReturnType<typeof createStripeClient>, { apply, concurrency, customerId, envFile, limit, refreshExisting }: BackfillOptions) {

  const rows = await fetchStripeInfoRows(db, {
    customerId,
    missingOnly: !refreshExisting,
  })
  const actionableRows = rows.filter(row => isActionableStripeCustomerId(row.customer_id) && !!row.subscription_id)
  const limitedRows = limit ? actionableRows.slice(0, limit) : actionableRows

  console.log(`Loaded ${rows.length} stripe_info rows (${actionableRows.length} actionable)`)
  console.log(`Env file: ${envFile}`)
  if (customerId)
    console.log(`Scoped to customer: ${customerId}`)
  if (refreshExisting)
    console.log('Mode: refresh canceled_at end dates and billing anchors')
  else
    console.log('Mode: fill missing canceled_at end dates only')
  if (!apply)
    console.log('Dry run only. Pass --apply to update stripe_info.')

  const failures: BackfillFailure[] = []
  const candidates: StripeSubscriptionEndBackfillCandidate[] = []
  let checked = 0

  await asyncPool(concurrency, limitedRows, async (row) => {
    try {
      const subscriptionId = row.subscription_id!
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      })
      const snapshot = getStripeSubscriptionEndSnapshot(subscription)

      if (hasSnapshotChanged(row, snapshot, refreshExisting)) {
        candidates.push({
          customer_id: row.customer_id,
          subscription_id: subscriptionId,
          current_anchor_start: normalizeIso(row.subscription_anchor_start),
          current_anchor_end: normalizeIso(row.subscription_anchor_end),
          current_canceled_at: normalizeIso(row.canceled_at),
          next_anchor_start: snapshot.subscription_anchor_start,
          next_anchor_end: snapshot.subscription_anchor_end,
          next_canceled_at: snapshot.canceled_at,
        })
      }
      checked++
      if (checked % 100 === 0 || checked === limitedRows.length)
        console.log(`Checked ${checked}/${limitedRows.length}`)
    }
    catch (error) {
      failures.push({
        customerId: row.customer_id,
        subscriptionId: row.subscription_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  console.log(`Candidates needing update: ${candidates.length}`)
  if (candidates.length > 0) {
    console.log('Sample updates:')
    for (const candidate of candidates.slice(0, 10)) {
      console.log(`${candidate.customer_id}: canceled_at ${candidate.current_canceled_at ?? 'null'} -> ${candidate.next_canceled_at ?? 'null'}, anchor_end ${candidate.current_anchor_end ?? 'null'} -> ${candidate.next_anchor_end ?? 'null'}`)
    }
  }

  if (!apply) {
    await writeFailures(failures)
    if (failures.length > 0)
      throw new Error(`Stripe subscription end-date backfill dry run had ${failures.length} failures`)
    return
  }

  let updated = 0
  await asyncPool(concurrency, candidates, async (candidate) => {
    try {
      await updateSubscriptionEndSnapshot(db, candidate)
      updated++
      if (updated % 100 === 0 || updated === candidates.length)
        console.log(`Updated ${updated}/${candidates.length}`)
    }
    catch (error) {
      failures.push({
        customerId: candidate.customer_id,
        subscriptionId: candidate.subscription_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  await writeFailures(failures)
  if (failures.length > 0)
    throw new Error(`Stripe subscription end-date backfill had ${failures.length} failures`)

  console.log(`Done. Updated ${updated}/${candidates.length} stripe_info rows.`)
}

if (import.meta.main)
  await main()
