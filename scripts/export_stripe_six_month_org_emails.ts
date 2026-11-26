/*
 * Export org member emails by Stripe customer billing status.
 *
 * Run:
 *   bun run stripe:export-six-month-org-emails
 *
 * Optional:
 *   bun run stripe:export-six-month-org-emails --output=./tmp/export.csv
 *   bun run stripe:export-six-month-org-emails --min-months=6
 *   bun run stripe:export-six-month-org-emails --status=active
 *   bun run stripe:export-six-month-org-emails --status=never_paid
 *   bun run stripe:export-six-month-org-emails --customer-id=cus_...
 *   bun run stripe:export-six-month-org-emails --env-file=./internal/cloudflare/.env.preprod
 */
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import type pg from 'pg'
import type { CustomerPaidSummary } from './stripe_paid_invoice_export_utils.ts'
import process from 'node:process'
import {
  connectAdminDb,
  createStripeClient,
  DEFAULT_ENV_FILE,
  getArgValue,
  getRequiredEnv,
  isActionableStripeCustomerId,
  loadEnv,
  parsePositiveInteger,
} from './admin_stripe_backfill_utils.ts'
import {
  buildPaidCustomerSummaries,
  collectPaidCoverageByCustomerId,
  escapeCsv,
  toPaidDurationMonths,
  writeCsv,
} from './stripe_paid_invoice_export_utils.ts'

const DEFAULT_OUTPUT = './tmp/stripe_six_month_org_emails.csv'
const DEFAULT_MIN_MONTHS = 6
const DEFAULT_PAGE_SIZE = 1000
const DB_CHUNK_SIZE = 200
const DEFAULT_STATUS_FILTER = 'paid'
const STATUS_FILTERS = ['paid', 'active', 'canceled', 'never_paid', 'all'] as const

type OrgRow = Pick<Database['public']['Tables']['orgs']['Row'], 'id' | 'customer_id'>
type RoleBindingRow = Pick<Database['public']['Tables']['role_bindings']['Row'], 'expires_at' | 'org_id' | 'principal_id'>
type UserEmailRow = Pick<Database['public']['Tables']['users']['Row'], 'email' | 'id'>
type StatusFilter = typeof STATUS_FILTERS[number]

interface ExportRow {
  activePaying: boolean
  email: string
  paidDurationMs: number
  paidDurationMonths: number
}

function printHelp() {
  console.log(`Export org member emails by Stripe customer billing status.

Usage:
  bun run stripe:export-six-month-org-emails [options]

Options:
  --output=PATH        CSV output path. Default: ${DEFAULT_OUTPUT}.
  --min-months=N      Minimum paid duration for paid, active, and canceled statuses. Default: ${DEFAULT_MIN_MONTHS}.
  --status=VALUE      One of: paid, active, canceled, never_paid, all. never_paid means trial orgs with no positive paid invoice. Default: ${DEFAULT_STATUS_FILTER}.
  --customer-id=ID    Limit export to one Stripe customer.
  --limit=N           Stop after N paid Stripe invoices. Only allowed for paid, active, canceled.
  --env-file=PATH     Env file to load. Default: ${DEFAULT_ENV_FILE}.
  --help              Show this help.

CSV columns:
  email,paid_duration_months,active_paying
`)
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size))
  return chunks
}

function normalizeEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase()
  return normalized || null
}

function parseStatusFilter(value: string | null) {
  const statusFilter = value ?? DEFAULT_STATUS_FILTER
  if (!STATUS_FILTERS.includes(statusFilter as StatusFilter))
    throw new Error(`--status must be one of: ${STATUS_FILTERS.join(', ')}`)
  return statusFilter as StatusFilter
}

async function fetchActionableOrgs(db: pg.Pool, customerId: string | null) {
  const rows: OrgRow[] = []
  let lastSeenOrgId: string | null = null

  while (true) {
    // With a customer id the loop stops after one page, so the cursor stays null.
    const { rows: data } = await db.query<OrgRow>(
      `SELECT id, customer_id
       FROM public.orgs
       WHERE customer_id IS NOT NULL
         AND ($1::text IS NULL OR customer_id = $1) AND ($2::uuid IS NULL OR id > $2::uuid)
       ORDER BY id ASC
       LIMIT $3`,
      [customerId || null, lastSeenOrgId, DEFAULT_PAGE_SIZE],
    )
    if (!data.length)
      break

    rows.push(...data)
    if (customerId || data.length < DEFAULT_PAGE_SIZE)
      break
    lastSeenOrgId = data.at(-1)?.id ?? null
  }

  return rows.filter(row => isActionableStripeCustomerId(row.customer_id))
}

function groupOrgsByCustomerId(orgs: OrgRow[]) {
  const orgsByCustomerId = new Map<string, OrgRow[]>()

  for (const org of orgs) {
    if (!org.customer_id)
      continue

    const existing = orgsByCustomerId.get(org.customer_id) ?? []
    existing.push(org)
    orgsByCustomerId.set(org.customer_id, existing)
  }

  return orgsByCustomerId
}

async function fetchRoleBindingRows(db: pg.Pool, orgIds: string[]) {
  const rows: RoleBindingRow[] = []

  for (const chunk of chunkItems(orgIds, DB_CHUNK_SIZE)) {
    const { rows: data } = await db.query<RoleBindingRow>(
      `SELECT expires_at, org_id, principal_id
       FROM public.role_bindings
       WHERE principal_type = 'user' AND org_id = ANY($1::uuid[])`,
      [chunk],
    )
    rows.push(...data)
  }

  return rows
}

async function fetchUserEmails(db: pg.Pool, userIds: string[]) {
  const usersById = new Map<string, string>()

  for (const chunk of chunkItems(userIds, DB_CHUNK_SIZE)) {
    const { rows: data } = await db.query<UserEmailRow>(
      'SELECT id, email FROM public.users WHERE id = ANY($1::uuid[])',
      [chunk],
    )

    for (const user of data) {
      const email = normalizeEmail(user.email)
      if (email)
        usersById.set(user.id, email)
    }
  }

  return usersById
}

async function fetchOrgMemberEmailsByOrgId(db: pg.Pool, orgIds: string[], nowMs: number) {
  const memberIdsByOrgId = new Map<string, Set<string>>()

  for (const orgId of orgIds)
    memberIdsByOrgId.set(orgId, new Set())

  const roleBindingRows = await fetchRoleBindingRows(db, orgIds)
  for (const row of roleBindingRows) {
    if (!row.org_id)
      continue
    if (row.expires_at && new Date(row.expires_at).getTime() <= nowMs)
      continue
    memberIdsByOrgId.get(row.org_id)?.add(row.principal_id)
  }

  const userIds = [...new Set([...memberIdsByOrgId.values()].flatMap(ids => [...ids]))]
  const usersById = await fetchUserEmails(db, userIds)
  const emailsByOrgId = new Map<string, Set<string>>()

  for (const [orgId, memberIds] of memberIdsByOrgId.entries()) {
    const emails = new Set<string>()
    for (const userId of memberIds) {
      const email = usersById.get(userId)
      if (email)
        emails.add(email)
    }
    emailsByOrgId.set(orgId, emails)
  }

  return emailsByOrgId
}

function filterCustomerSummaries(customerSummaries: CustomerPaidSummary[], statusFilter: StatusFilter) {
  if (statusFilter === 'active')
    return customerSummaries.filter(summary => summary.activePaying)
  if (statusFilter === 'canceled')
    return customerSummaries.filter(summary => !summary.activePaying)
  if (statusFilter === 'never_paid')
    return []
  return customerSummaries
}

function buildNeverPaidCustomerSummaries(
  customerIds: Set<string>,
  customerIdsWithPositivePaidInvoices: Set<string>,
  statusFilter: StatusFilter,
) {
  if (statusFilter !== 'never_paid' && statusFilter !== 'all')
    return []

  return [...customerIds]
    .filter(customerId => !customerIdsWithPositivePaidInvoices.has(customerId))
    .map((customerId): CustomerPaidSummary => ({
      activePaying: false,
      customerId,
      paidDurationMs: 0,
      paidDurationMonths: 0,
    }))
}

function buildExportRows(
  customerSummaries: CustomerPaidSummary[],
  orgsByCustomerId: Map<string, OrgRow[]>,
  emailsByOrgId: Map<string, Set<string>>,
) {
  const rowsByEmail = new Map<string, ExportRow>()

  for (const summary of customerSummaries) {
    const orgs = orgsByCustomerId.get(summary.customerId) ?? []
    for (const org of orgs) {
      const emails = emailsByOrgId.get(org.id) ?? new Set()
      for (const email of emails) {
        const existing = rowsByEmail.get(email)
        const paidDurationMs = Math.max(existing?.paidDurationMs ?? 0, summary.paidDurationMs)
        rowsByEmail.set(email, {
          email,
          activePaying: !!existing?.activePaying || summary.activePaying,
          paidDurationMs,
          paidDurationMonths: toPaidDurationMonths(paidDurationMs),
        })
      }
    }
  }

  return [...rowsByEmail.values()].sort((left, right) => {
    if (left.activePaying !== right.activePaying)
      return left.activePaying ? -1 : 1
    if (left.paidDurationMs !== right.paidDurationMs)
      return right.paidDurationMs - left.paidDurationMs
    return left.email.localeCompare(right.email)
  })
}

function toCsv(rows: ExportRow[]) {
  const header = ['email', 'paid_duration_months', 'active_paying']
  const lines = rows.map(row => [
    row.email,
    row.paidDurationMonths.toFixed(2),
    row.activePaying,
  ].map(escapeCsv).join(','))

  return `${[header.join(','), ...lines].join('\n')}\n`
}

async function main(args = process.argv.slice(2), runtimeEnv: Record<string, string | undefined> = process.env) {
  if (args.includes('--help')) {
    printHelp()
    return
  }

  const envFile = getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE
  const outputPath = getArgValue(args, '--output') ?? DEFAULT_OUTPUT
  const customerId = getArgValue(args, '--customer-id')
  const minMonths = parsePositiveInteger(getArgValue(args, '--min-months'), '--min-months', DEFAULT_MIN_MONTHS)
  const statusFilter = parseStatusFilter(getArgValue(args, '--status'))
  const invoiceLimit = getArgValue(args, '--limit')
    ? parsePositiveInteger(getArgValue(args, '--limit'), '--limit', 0)
    : null

  if (customerId && !isActionableStripeCustomerId(customerId))
    throw new Error('--customer-id must be a real Stripe customer id')
  if (invoiceLimit && (statusFilter === 'never_paid' || statusFilter === 'all'))
    throw new Error('--limit cannot be used with --status=never_paid or --status=all because it would misclassify paid org customers')

  const fileEnv = await loadEnv(envFile)
  const env = {
    ...fileEnv,
    ...runtimeEnv,
  }
  const nowMs = Date.now()

  const stripe = createStripeClient(
    getRequiredEnv(env, 'STRIPE_SECRET_KEY'),
    env.STRIPE_API_BASE_URL?.trim(),
  )
  const db = await connectAdminDb(env)
  try {
    await exportEmails(db, stripe, { customerId, envFile, invoiceLimit, minMonths, nowMs, outputPath, statusFilter })
  }
  finally {
    await db.end()
  }
}

interface ExportOptions {
  customerId: string | null
  envFile: string
  invoiceLimit: number | null
  minMonths: number
  nowMs: number
  outputPath: string
  statusFilter: StatusFilter
}

async function exportEmails(db: pg.Pool, stripe: ReturnType<typeof createStripeClient>, { customerId, envFile, invoiceLimit, minMonths, nowMs, outputPath, statusFilter }: ExportOptions) {

  const orgs = await fetchActionableOrgs(db, customerId)
  const orgsByCustomerId = groupOrgsByCustomerId(orgs)
  const customerIds = new Set(orgsByCustomerId.keys())

  console.log(`Loaded ${orgs.length} orgs with actionable Stripe customer ids`)
  console.log(`Env file: ${envFile}`)
  console.log(`Minimum paid duration: ${minMonths} months`)
  console.log(`Status filter: ${statusFilter}`)
  if (customerId)
    console.log(`Scoped to customer: ${customerId}`)

  if (customerIds.size === 0) {
    await writeCsv(outputPath, toCsv([]))
    console.log(`No matching org customers found. Wrote empty CSV to ${outputPath}`)
    return
  }

  const {
    coverageByCustomerId,
    customerIdsWithPositivePaidInvoices,
  } = await collectPaidCoverageByCustomerId(stripe, {
    customerId,
    includeCustomerIds: customerIds,
    invoiceLimit,
    nowMs,
  })
  const paidCustomerSummaries = buildPaidCustomerSummaries(
    coverageByCustomerId,
    statusFilter === 'all' ? { nowMs } : { minMonths, nowMs },
  )
  const customerSummaries = [
    ...filterCustomerSummaries(paidCustomerSummaries, statusFilter),
    ...buildNeverPaidCustomerSummaries(customerIds, customerIdsWithPositivePaidInvoices, statusFilter),
  ]
  const qualifyingOrgIds = customerSummaries
    .flatMap(summary => orgsByCustomerId.get(summary.customerId) ?? [])
    .map(org => org.id)

  console.log(`Qualifying Stripe customers: ${customerSummaries.length}`)
  console.log(`Qualifying orgs: ${qualifyingOrgIds.length}`)

  const emailsByOrgId = await fetchOrgMemberEmailsByOrgId(db, qualifyingOrgIds, nowMs)
  const exportRows = buildExportRows(customerSummaries, orgsByCustomerId, emailsByOrgId)
  const csv = toCsv(exportRows)
  await writeCsv(outputPath, csv)

  console.log(`Wrote ${exportRows.length} email rows to ${outputPath}`)
}

if (import.meta.main)
  await main()
