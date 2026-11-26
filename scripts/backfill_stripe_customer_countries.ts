/*
 * Backfill the admin "Top Billing Countries" metric.
 *
 * The dashboard reads public.stripe_info.customer_country. This script syncs
 * that column from Stripe customer profile addresses for historical customers.
 *
 * Dry run for missing country rows:
 *   bun run stripe:backfill-customer-countries
 *
 * Apply missing countries:
 *   bun run stripe:backfill-customer-countries --apply
 *
 * Refresh existing country values too:
 *   bun run stripe:backfill-customer-countries --apply --refresh-existing
 */
import type Stripe from 'stripe'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import type pg from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { asyncPool, connectAdminDb, createStripeClient, DEFAULT_ENV_FILE, getArgValue, getRequiredEnv, isActionableStripeCustomerId, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const DEFAULT_CONCURRENCY = 8
const DEFAULT_PAGE_SIZE = 1000
const FAILURE_OUTPUT = './tmp/stripe_customer_country_backfill_failures.json'
const ISO_COUNTRY_CODE_REGEX = /^[A-Z]{2}$/

type StripeInfoCountryRow = Pick<
  Database['public']['Tables']['stripe_info']['Row'],
  'customer_id' | 'customer_country'
>

export interface StripeCustomerCountryBackfillCandidate {
  current_country: string | null
  customer_id: string
  next_country: string | null
}

interface BackfillFailure {
  customerId: string
  error: string
}

export function normalizeStripeCountryCode(country: string | null | undefined) {
  if (!country)
    return null

  const normalized = country.trim().toUpperCase()
  if (!normalized || !ISO_COUNTRY_CODE_REGEX.test(normalized))
    return null

  return normalized
}

export function getCustomerProfileCountry(customer: Stripe.Customer | Stripe.DeletedCustomer) {
  if (customer.deleted)
    return null

  return normalizeStripeCountryCode(customer.address?.country ?? null)
}

export function shouldUpdateCustomerCountry(currentCountry: string | null | undefined, nextCountry: string | null, refreshExisting: boolean) {
  const normalizedCurrentCountry = normalizeStripeCountryCode(currentCountry)
  if (refreshExisting)
    return normalizedCurrentCountry !== nextCountry
  return normalizedCurrentCountry === null && nextCountry !== null
}

async function fetchStripeInfoCountryRows(
  db: pg.Pool,
  options: {
    customerId?: string | null
    missingOnly: boolean
  },
) {
  const rows: StripeInfoCountryRow[] = []
  let lastSeenCustomerId: string | null = null

  while (true) {
    const { rows: data }: { rows: StripeInfoCountryRow[] } = await db.query<StripeInfoCountryRow>(
      `SELECT customer_id, customer_country
       FROM public.stripe_info
       WHERE ($1::text IS NULL OR customer_id = $1) AND ($2::text IS NULL OR customer_id > $2)
         AND (NOT $3::boolean OR customer_country IS NULL)
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

async function updateCustomerCountry(db: pg.Pool, customerId: string, country: string | null) {
  await db.query('UPDATE public.stripe_info SET customer_country = $1 WHERE customer_id = $2', [country, customerId])
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

  const rows = await fetchStripeInfoCountryRows(db, {
    customerId,
    missingOnly: !refreshExisting,
  })
  const actionableRows = rows.filter(row => isActionableStripeCustomerId(row.customer_id))
  const limitedRows = limit ? actionableRows.slice(0, limit) : actionableRows

  console.log(`Loaded ${rows.length} stripe_info rows (${actionableRows.length} actionable)`)
  console.log(`Env file: ${envFile}`)
  if (customerId)
    console.log(`Scoped to customer: ${customerId}`)
  if (refreshExisting)
    console.log('Mode: refresh existing country values')
  else
    console.log('Mode: fill missing country values only')

  const failures: BackfillFailure[] = []
  const candidates: StripeCustomerCountryBackfillCandidate[] = []
  let checked = 0

  await asyncPool(concurrency, limitedRows, async (row) => {
    try {
      const customer = await stripe.customers.retrieve(row.customer_id)
      const nextCountry = getCustomerProfileCountry(customer)
      if (shouldUpdateCustomerCountry(row.customer_country, nextCountry, refreshExisting)) {
        candidates.push({
          customer_id: row.customer_id,
          current_country: normalizeStripeCountryCode(row.customer_country),
          next_country: nextCountry,
        })
      }
      checked++
      if (checked % 100 === 0 || checked === limitedRows.length)
        console.log(`Checked ${checked}/${limitedRows.length}`)
    }
    catch (error) {
      failures.push({
        customerId: row.customer_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  console.log(`Candidates needing update: ${candidates.length}`)
  if (candidates.length > 0) {
    console.log('Sample updates:')
    for (const candidate of candidates.slice(0, 10)) {
      const from = candidate.current_country ?? 'null'
      const to = candidate.next_country ?? 'null'
      console.log(`${candidate.customer_id}: ${from} -> ${to}`)
    }
  }

  if (!apply) {
    await writeFailures(failures)
    if (failures.length > 0)
      throw new Error(`Stripe customer country backfill dry run had ${failures.length} failures`)
    console.log('Dry run only. Pass --apply to update stripe_info.')
    return
  }

  let updated = 0
  await asyncPool(concurrency, candidates, async (candidate) => {
    try {
      await updateCustomerCountry(db, candidate.customer_id, candidate.next_country)
      updated++
      if (updated % 100 === 0 || updated === candidates.length)
        console.log(`Updated ${updated}/${candidates.length}`)
    }
    catch (error) {
      failures.push({
        customerId: candidate.customer_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  await writeFailures(failures)
  if (failures.length > 0)
    throw new Error(`Stripe customer country backfill completed with ${failures.length} failures`)

  console.log(`Done. Updated ${updated}/${candidates.length} customer country rows.`)
}

if (import.meta.main)
  await main()
