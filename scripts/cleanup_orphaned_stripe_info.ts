/*
 * Delete stripe_info rows that no longer have a linked org.
 *
 * Includes real Stripe customer IDs (cus_*) and pending placeholders (pending_{org_id}).
 *
 * Run:
 *   bun run stripe:cleanup-orphaned-stripe-info
 *
 * Apply deletions:
 *   bun run stripe:cleanup-orphaned-stripe-info --apply
 */
import type pg from 'pg'
import type Stripe from 'stripe'
import process from 'node:process'
import {
  asyncPool,
  connectAdminDb,
  createStripeClient,
  DEFAULT_ENV_FILE,
  getArgValue,
  getRequiredEnv,
  isActionableStripeCustomerId,
  loadEnv,
  parsePositiveInteger,
} from './admin_stripe_backfill_utils.ts'
import { escapeCsv, writeCsv } from './stripe_paid_invoice_export_utils.ts'

const DEFAULT_OUTPUT = './tmp/orphaned_stripe_info.csv'
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_CONCURRENCY = 8

interface OrphanRow {
  customerId: string
  status: string | null
  subscriptionId: string | null
}

async function fetchStripeInfoRows(db: pg.Pool) {
  const rows: OrphanRow[] = []
  let lastSeenCustomerId: string | null = null

  while (true) {
    const { rows: data } = await db.query<{ customer_id: string, status: string | null, subscription_id: string | null }>(
      `SELECT customer_id, status, subscription_id
       FROM public.stripe_info
       WHERE $1::text IS NULL OR customer_id > $1
       ORDER BY customer_id ASC
       LIMIT $2`,
      [lastSeenCustomerId, DEFAULT_PAGE_SIZE],
    )
    if (!data.length)
      break

    rows.push(...data.map(row => ({
      customerId: row.customer_id,
      status: row.status,
      subscriptionId: row.subscription_id,
    })))

    if (data.length < DEFAULT_PAGE_SIZE)
      break
    lastSeenCustomerId = data.at(-1)?.customer_id ?? null
  }

  return rows
}

async function fetchLinkedCustomerIds(db: pg.Pool, customerIds: string[]) {
  const linked = new Set<string>()

  for (let index = 0; index < customerIds.length; index += 200) {
    const chunk = customerIds.slice(index, index + 200)
    const { rows: data } = await db.query<{ customer_id: string | null }>(
      'SELECT customer_id FROM public.orgs WHERE customer_id = ANY($1)',
      [chunk],
    )

    for (const row of data) {
      if (row.customer_id)
        linked.add(row.customer_id)
    }
  }

  return linked
}

async function fetchLinkedOrgIds(db: pg.Pool) {
  const linkedOrgIds = new Set<string>()
  let lastSeenOrgId: string | null = null

  while (true) {
    const { rows: data } = await db.query<{ id: string }>(
      `SELECT id
       FROM public.orgs
       WHERE $1::uuid IS NULL OR id > $1::uuid
       ORDER BY id ASC
       LIMIT $2`,
      [lastSeenOrgId, DEFAULT_PAGE_SIZE],
    )
    if (!data.length)
      break

    for (const row of data) {
      if (row.id)
        linkedOrgIds.add(row.id)
    }

    if (data.length < DEFAULT_PAGE_SIZE)
      break
    lastSeenOrgId = data.at(-1)?.id ?? null
  }

  return linkedOrgIds
}

function isOrphanedStripeInfoRow(
  row: OrphanRow,
  linkedCustomerIds: Set<string>,
  linkedOrgIds: Set<string>,
) {
  if (linkedCustomerIds.has(row.customerId))
    return false

  if (row.customerId.startsWith('pending_')) {
    const orgId = row.customerId.slice('pending_'.length)
    return !!orgId && !linkedOrgIds.has(orgId)
  }

  return isActionableStripeCustomerId(row.customerId)
}

async function cancelStripeSubscriptions(stripe: Stripe, customerId: string) {
  for await (const subscription of stripe.subscriptions.list({ customer: customerId, status: 'all' })) {
    if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired')
      continue
    await stripe.subscriptions.cancel(subscription.id)
  }
}

function toCsv(rows: OrphanRow[]) {
  const header = ['customer_id', 'status', 'subscription_id']
  const lines = rows.map(row => [
    row.customerId,
    row.status ?? '',
    row.subscriptionId ?? '',
  ].map(escapeCsv).join(','))
  return `${[header.join(','), ...lines].join('\n')}\n`
}

async function main(args = process.argv.slice(2), runtimeEnv: Record<string, string | undefined> = process.env) {
  const apply = args.includes('--apply')
  const envFile = getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE
  const outputPath = getArgValue(args, '--output') ?? DEFAULT_OUTPUT
  const concurrency = parsePositiveInteger(getArgValue(args, '--concurrency'), '--concurrency', DEFAULT_CONCURRENCY)

  const env = { ...(await loadEnv(envFile)), ...runtimeEnv }
  const stripe = createStripeClient(
    getRequiredEnv(env, 'STRIPE_SECRET_KEY'),
    env.STRIPE_API_BASE_URL?.trim(),
  )
  const db = await connectAdminDb(env)
  try {
    await cleanup(db, stripe, { apply, concurrency, outputPath })
  }
  finally {
    await db.end()
  }
}

async function cleanup(db: pg.Pool, stripe: Stripe, { apply, concurrency, outputPath }: { apply: boolean, concurrency: number, outputPath: string }) {

  const stripeInfoRows = await fetchStripeInfoRows(db)
  const linkedCustomerIds = await fetchLinkedCustomerIds(
    db,
    stripeInfoRows.map(row => row.customerId),
  )
  const linkedOrgIds = await fetchLinkedOrgIds(db)

  const orphans = stripeInfoRows.filter(row =>
    isOrphanedStripeInfoRow(row, linkedCustomerIds, linkedOrgIds))

  await writeCsv(outputPath, toCsv(orphans))
  console.log(`Found ${orphans.length} orphaned stripe_info rows`)
  console.log(`Wrote report to ${outputPath}`)

  if (!apply) {
    console.log('Dry run only. Pass --apply to delete orphaned stripe_info rows.')
    return
  }

  const failures: { customerId: string, error: string }[] = []

  await asyncPool(concurrency, orphans, async (row) => {
    try {
      if (isActionableStripeCustomerId(row.customerId))
        await cancelStripeSubscriptions(stripe, row.customerId)
      await db.query('DELETE FROM public.stripe_info WHERE customer_id = $1', [row.customerId])
    }
    catch (error) {
      failures.push({
        customerId: row.customerId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  console.log(`Deleted ${orphans.length - failures.length} orphaned stripe_info rows`)
  if (failures.length) {
    console.log(`Failures: ${failures.length}`)
    process.exitCode = 1
  }
}

if (import.meta.main)
  await main()
