/*
 * Resync Stripe customer names from public.orgs.name.
 *
 * Dry run:
 *   bun run stripe:sync-org-names
 *
 * Apply:
 *   bun run stripe:sync-org-names --apply
 *
 * Optional:
 *   bun run stripe:sync-org-names --apply --org-id=<uuid>
 *   bun run stripe:sync-org-names --apply --limit=100
 *   bun run stripe:sync-org-names --apply --concurrency=10
 *   bun run stripe:sync-org-names --apply --env-file=./internal/cloudflare/.env.preprod
 */
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import { createClient } from './db-client.ts'
import Stripe from 'stripe'

const DEFAULT_ENV_FILE = './internal/cloudflare/.env.prod'
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_CONCURRENCY = 10
const FAILURE_OUTPUT = './tmp/stripe_org_name_sync_failures.json'

type OrgRow = Pick<Database['public']['Tables']['orgs']['Row'], 'id' | 'name' | 'customer_id'>

function getArgValue(prefix: string): string | null {
  const arg = Bun.argv.find(value => value.startsWith(`${prefix}=`))
  if (!arg)
    return null
  return arg.slice(prefix.length + 1)
}

async function loadEnv(filePath: string) {
  const file = Bun.file(filePath)
  if (!(await file.exists()))
    return {}

  const text = await file.text()
  const env: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0)
      continue

    const key = trimmed.slice(0, separatorIndex)
    const value = trimmed.slice(separatorIndex + 1)
    env[key] = value
  }

  return env
}

function getRequiredEnv(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  if (!value)
    throw new Error(`Missing ${key}`)
  return value
}

function createStripeClient(secretKey: string, apiBaseUrl?: string) {
  let hostConfig: Partial<Pick<NonNullable<ConstructorParameters<typeof Stripe>[1]>, 'host' | 'port' | 'protocol'>> = {}

  if (apiBaseUrl?.trim()) {
    const parsed = new URL(apiBaseUrl)
    hostConfig = {
      host: parsed.hostname,
      port: Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10),
      protocol: parsed.protocol.replace(':', '') as 'http' | 'https',
    }
  }

  type StripeApiVersion = NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']
  return new Stripe(secretKey, {
    apiVersion: '2026-03-25.dahlia' as StripeApiVersion,
    httpClient: Stripe.createFetchHttpClient(),
    ...hostConfig,
  })
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function asyncPool<T>(limit: number, items: T[], iterator: (item: T) => Promise<void>) {
  const executing = new Set<Promise<void>>()

  for (const item of items) {
    const task = iterator(item).finally(() => {
      executing.delete(task)
    })
    executing.add(task)

    if (executing.size >= limit)
      await Promise.race(executing)
  }

  await Promise.all(executing)
}

async function fetchTargetOrgs(supabase: ReturnType<typeof createClient<Database>>, orgId?: string | null) {
  if (orgId) {
    const { data, error } = await supabase
      .from('orgs')
      .select('id, name, customer_id')
      .eq('id', orgId)
      .maybeSingle()

    if (error)
      throw error

    return data ? [data] : []
  }

  const rows: OrgRow[] = []
  let lastSeenOrgId: string | null = null

  while (true) {
    let query = supabase
      .from('orgs')
      .select('id, name, customer_id')
      .not('customer_id', 'is', null)
      .order('id', { ascending: true })
      .limit(DEFAULT_PAGE_SIZE)

    if (lastSeenOrgId)
      query = query.gt('id', lastSeenOrgId)

    const { data, error } = await query

    if (error)
      throw error

    if (!data?.length)
      break

    rows.push(...data)
    lastSeenOrgId = data.at(-1)?.id ?? null
  }

  return rows
}

async function main() {
  const apply = Bun.argv.includes('--apply')
  const envFile = getArgValue('--env-file') ?? DEFAULT_ENV_FILE
  const orgId = getArgValue('--org-id')
  const limitArg = getArgValue('--limit')
  const concurrencyArg = getArgValue('--concurrency')
  const limit = limitArg ? Number.parseInt(limitArg, 10) : null
  const concurrency = concurrencyArg ? Number.parseInt(concurrencyArg, 10) : DEFAULT_CONCURRENCY

  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('--concurrency must be a positive integer')
  if (limit !== null && (!Number.isInteger(limit) || limit < 1))
    throw new Error('--limit must be a positive integer')

  const fileEnv = await loadEnv(envFile)
  const env = {
    ...fileEnv,
    ...Bun.env,
  }

  const supabaseUrl = getRequiredEnv(env, 'SUPABASE_URL')
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_SERVICE_KEY?.trim()
  if (!supabaseServiceRoleKey)
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
  const stripeSecretKey = getRequiredEnv(env, 'STRIPE_SECRET_KEY')
  const stripeApiBaseUrl = env.STRIPE_API_BASE_URL?.trim()

  const supabase = createClient<Database>(
    supabaseUrl,
    supabaseServiceRoleKey,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL ?? env.DB_URL },
  )
  const stripe = createStripeClient(stripeSecretKey, stripeApiBaseUrl)

  const orgs = await fetchTargetOrgs(supabase, orgId)
  const actionableOrgs = orgs
    .filter(org => !!org.customer_id && !org.customer_id.startsWith('pending_'))
    .filter(org => !!org.name?.trim())

  const limitedOrgs = limit ? actionableOrgs.slice(0, limit) : actionableOrgs

  console.log(`Loaded ${orgs.length} orgs (${actionableOrgs.length} actionable)`)
  console.log(`Env file: ${envFile}`)
  if (orgId)
    console.log(`Scoped to org: ${orgId}`)
  if (!apply) {
    console.log('Dry run only. Pass --apply to update Stripe.')
    console.log('Sample:')
    for (const org of limitedOrgs.slice(0, 10)) {
      console.log(`- ${org.id} -> ${org.customer_id} (${org.name})`)
    }
    return
  }

  if (limitedOrgs.length === 0) {
    console.log('Nothing to update.')
    return
  }

  const failures: Array<{ orgId: string, customerId: string, name: string, error: string }> = []
  let updated = 0

  for (const chunk of chunkArray(limitedOrgs, 500)) {
    await asyncPool(concurrency, chunk, async (org) => {
      try {
        await stripe.customers.update(org.customer_id!, { name: org.name })
        updated++
        if (updated % 50 === 0 || updated === limitedOrgs.length)
          console.log(`Updated ${updated}/${limitedOrgs.length}`)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({
          orgId: org.id,
          customerId: org.customer_id!,
          name: org.name,
          error: message,
        })
        console.error(`Failed org ${org.id} (${org.customer_id}): ${message}`)
      }
    })
  }

  console.log(`Done. Updated ${updated}/${limitedOrgs.length}. Failures: ${failures.length}`)

  if (failures.length > 0) {
    await Bun.mkdir('./tmp', { recursive: true })
    await Bun.write(FAILURE_OUTPUT, `${JSON.stringify(failures, null, 2)}\n`)
    console.log(`Failure details written to ${FAILURE_OUTPUT}`)
    throw new Error(`Stripe org name sync completed with ${failures.length} failures`)
  }
}

await main()
