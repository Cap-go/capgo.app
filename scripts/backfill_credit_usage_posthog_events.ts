/*
 * Backfill usage credit ledger PostHog events from public.usage_credit_transactions.
 *
 * Dry-run the past 90 days:
 *   bun run admin:backfill-credit-usage-posthog
 *
 * Send events for the past 90 days:
 *   bun run admin:backfill-credit-usage-posthog --apply
 *
 * Send a specific range:
 *   bun run admin:backfill-credit-usage-posthog --apply --from=2026-03-01 --cutover=2026-06-01T00:00:00Z
 *
 * Reuse a run marker across retries:
 *   bun run admin:backfill-credit-usage-posthog --apply --backfill-run-id=credits-2026-q2
 */
import process from 'node:process'
import type { UsageOverageEventRow } from '../supabase/functions/_backend/utils/credit_usage_posthog.ts'
import { buildCreditUsagePosthogEventInput, getCreditUsageSourceRefOverageEventId } from '../supabase/functions/_backend/utils/credit_usage_posthog.ts'
import type pg from 'pg'
import { connectAdminDb, DEFAULT_ENV_FILE, getArgValue, getRequiredEnv, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const DEFAULT_DAYS = 90
const DEFAULT_BATCH_SIZE = 500
const DEFAULT_POSTHOG_CAPTURE_URL = 'https://eu.i.posthog.com/capture/'
export const CREDIT_USAGE_BACKFILL_JOB_NAME = 'credit_usage_posthog_events'

export interface BackfillProgressRow {
  cutover_at: string
  job_name: string
  last_processed_id: number | null
  last_processed_occurred_at: string | null
  scope_key: string
}

interface BackfillRunTagOptions {
  backfillRangeFrom: string
  backfillRangeTo: string
  backfillRunId: string
  backfillStartedAt: string
}

function printHelp() {
  console.log(`Backfill usage credit ledger events into PostHog.

Usage:
  bun run admin:backfill-credit-usage-posthog [options]

Options:
  --apply              Send events to PostHog. Without this, dry-run only.
  --days=N             Look back N days when --from is not supplied. Default: ${DEFAULT_DAYS}.
  --from=YYYY-MM-DD    Start occurred_at date, inclusive.
  --to=YYYY-MM-DD      End occurred_at date, exclusive. Default: now.
  --cutover=TIMESTAMP  Exclude transactions at or after this timestamp. Required for first --apply run.
  --org-id=UUID        Limit to one organization.
  --limit=N            Stop after N transactions.
  --batch-size=N       Database page size. Default: ${DEFAULT_BATCH_SIZE}.
  --backfill-run-id=ID Mark all emitted events with this run id. Defaults to a generated id.
  --env-file=PATH      Env file to load. Default: ${DEFAULT_ENV_FILE}.
  --help               Show this help.

Required env:
  MAIN_SUPABASE_DB_URL (or DATABASE_URL, SUPABASE_DB_URL, SUPABASE_DB_DIRECT_URL)

Required for --apply:
  POSTHOG_API_KEY

Optional env:
  CREDIT_USAGE_POSTHOG_BACKFILL_CUTOVER_AT
  POSTHOG_API_HOST     Defaults to ${DEFAULT_POSTHOG_CAPTURE_URL}
`)
}

function parseDate(value: string, label: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    throw new Error(`${label} must be a valid date`)
  return date
}

function normalizePosthogCaptureUrl(host: string | undefined) {
  const resolvedHost = host?.trim() || DEFAULT_POSTHOG_CAPTURE_URL
  return resolvedHost.endsWith('/capture/')
    ? resolvedHost
    : new URL('capture/', resolvedHost.endsWith('/') ? resolvedHost : `${resolvedHost}/`).toString()
}

export function getBackfillProgressScopeKey(orgId: string | null | undefined) {
  return orgId?.trim() ? `org:${orgId.trim()}` : 'all_orgs'
}

// SQL condition for rows after the last processed (occurred_at, id) pair.
// `firstParam` is the placeholder number of the first of its two parameters.
export function buildCheckpointResumeFilter(lastProcessedOccurredAt: string, lastProcessedId: number, firstParam: number) {
  const at = `$${firstParam}`
  const id = `$${firstParam + 1}`
  return {
    sql: `(occurred_at > ${at} OR (occurred_at = ${at} AND id > ${id}))`,
    params: [lastProcessedOccurredAt, lastProcessedId],
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function addBackfillRunTags(input: ReturnType<typeof buildCreditUsagePosthogEventInput>, options: BackfillRunTagOptions) {
  input.tags.backfill_range_from = options.backfillRangeFrom
  input.tags.backfill_range_to = options.backfillRangeTo
  input.tags.backfill_run_id = options.backfillRunId
  input.tags.backfill_started_at = options.backfillStartedAt
  return input
}

function normalizeIsoDate(value: string, label: string) {
  return parseDate(value, label).toISOString()
}

function isSameInstant(left: string, right: string) {
  return normalizeIsoDate(left, 'checkpoint cutover_at') === normalizeIsoDate(right, 'configured cutover')
}

export function resolveCutoverIso(options: {
  apply: boolean
  configuredCutover: string | null
  progress: BackfillProgressRow | null
  to: Date
}) {
  if (options.configuredCutover)
    return normalizeIsoDate(options.configuredCutover, '--cutover')

  if (options.progress?.cutover_at)
    return normalizeIsoDate(options.progress.cutover_at, 'checkpoint cutover_at')

  if (options.apply) {
    throw new Error(
      'Missing cutover timestamp. Pass --cutover=<timestamp> or set CREDIT_USAGE_POSTHOG_BACKFILL_CUTOVER_AT for the first --apply run.',
    )
  }

  return options.to.toISOString()
}

async function loadBackfillProgress(db: pg.Pool, jobName: string, scopeKey: string): Promise<BackfillProgressRow | null> {
  try {
    const { rows } = await db.query<BackfillProgressRow>(
      `SELECT job_name, scope_key, cutover_at, last_processed_occurred_at, last_processed_id
       FROM public.backfill_progress
       WHERE job_name = $1 AND scope_key = $2`,
      [jobName, scopeKey],
    )
    return rows[0] ?? null
  }
  catch (error) {
    throw new Error(`Failed to load backfill checkpoint: ${errorMessage(error)}`)
  }
}

async function saveBackfillProgress(db: pg.Pool, progress: BackfillProgressRow) {
  try {
    await db.query(
      `INSERT INTO public.backfill_progress (cutover_at, job_name, last_processed_id, last_processed_occurred_at, scope_key, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (job_name, scope_key) DO UPDATE SET
         cutover_at = EXCLUDED.cutover_at,
         last_processed_id = EXCLUDED.last_processed_id,
         last_processed_occurred_at = EXCLUDED.last_processed_occurred_at,
         updated_at = EXCLUDED.updated_at`,
      [progress.cutover_at, progress.job_name, progress.last_processed_id, progress.last_processed_occurred_at, progress.scope_key, new Date().toISOString()],
    )
  }
  catch (error) {
    throw new Error(`Failed to save backfill checkpoint: ${errorMessage(error)}`)
  }
}

async function sendPosthogEvent(posthogUrl: string, apiKey: string, input: ReturnType<typeof buildCreditUsagePosthogEventInput>) {
  const response = await fetch(posthogUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      distinct_id: input.distinctId,
      event: input.event,
      properties: {
        ...input.tags,
        $groups: input.groups,
        channel: input.channel,
        description: input.description,
      },
      timestamp: input.timestamp,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`PostHog capture failed: ${response.status} ${body}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    printHelp()
    return
  }

  const envFile = getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE
  const fileEnv = await loadEnv(envFile)
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env }
  const apply = args.includes('--apply')
  const days = parsePositiveInteger(getArgValue(args, '--days'), '--days', DEFAULT_DAYS)
  const batchSize = parsePositiveInteger(getArgValue(args, '--batch-size'), '--batch-size', DEFAULT_BATCH_SIZE)
  const limit = getArgValue(args, '--limit') ? parsePositiveInteger(getArgValue(args, '--limit'), '--limit', 0) : null
  const orgId = getArgValue(args, '--org-id')
  const scopeKey = getBackfillProgressScopeKey(orgId)
  const backfillStartedAt = new Date().toISOString()
  const backfillRunId = getArgValue(args, '--backfill-run-id')?.trim()
    || `credit-usage-posthog-${backfillStartedAt.replace(/[:.]/g, '-')}`
  const to = getArgValue(args, '--to') ? parseDate(getArgValue(args, '--to')!, '--to') : new Date()
  const from = getArgValue(args, '--from')
    ? parseDate(getArgValue(args, '--from')!, '--from')
    : new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  const db = await connectAdminDb(env)
  const progress = await loadBackfillProgress(db, CREDIT_USAGE_BACKFILL_JOB_NAME, scopeKey)
  const configuredCutover = getArgValue(args, '--cutover') ?? env.CREDIT_USAGE_POSTHOG_BACKFILL_CUTOVER_AT?.trim() ?? null
  const cutoverIso = resolveCutoverIso({ apply, configuredCutover, progress, to })

  if (progress?.cutover_at && !isSameInstant(progress.cutover_at, cutoverIso)) {
    throw new Error(
      `Checkpoint cutover_at (${progress.cutover_at}) does not match configured cutover (${cutoverIso}) for ${CREDIT_USAGE_BACKFILL_JOB_NAME}/${scopeKey}.`,
    )
  }

  const upperBound = to < parseDate(cutoverIso, '--cutover') ? to : parseDate(cutoverIso, '--cutover')

  if (from >= upperBound)
    throw new Error('--from must be before the earlier of --to and --cutover')

  const posthogApiKey = apply ? getRequiredEnv(env, 'POSTHOG_API_KEY') : ''
  const posthogUrl = normalizePosthogCaptureUrl(env.POSTHOG_API_HOST)
  const fromIso = from.toISOString()
  const toIso = upperBound.toISOString()

  let resumeOccurredAt = progress?.last_processed_occurred_at ? normalizeIsoDate(progress.last_processed_occurred_at, 'checkpoint last_processed_occurred_at') : null
  let resumeId = progress?.last_processed_id ?? null

  console.log(`${apply ? 'Applying' : 'Dry-running'} usage credit PostHog backfill`)
  console.log(`Backfill run id: ${backfillRunId}`)
  console.log(`Checkpoint scope: ${CREDIT_USAGE_BACKFILL_JOB_NAME}/${scopeKey}`)
  console.log(`Cutover: ${cutoverIso}`)
  if (resumeOccurredAt && resumeId !== null)
    console.log(`Resuming after: (${resumeOccurredAt}, ${resumeId})`)
  console.log(`Range: ${fromIso} <= occurred_at < ${toIso}`)
  if (orgId)
    console.log(`Org: ${orgId}`)
  console.log(`Batch size: ${batchSize}`)

  let seen = 0
  let sent = 0
  let skipped = 0
  const byType = new Map<string, number>()
  const byMetric = new Map<string, number>()

  while (limit === null || seen < limit) {
    const remaining = limit === null ? batchSize : Math.min(batchSize, limit - seen)
    const conditions = ['occurred_at >= $1', 'occurred_at < $2']
    const params: unknown[] = [fromIso, toIso]
    if (orgId) {
      params.push(orgId)
      conditions.push(`org_id = $${params.length}`)
    }
    if (resumeOccurredAt && resumeId !== null) {
      const resume = buildCheckpointResumeFilter(resumeOccurredAt, resumeId, params.length + 1)
      params.push(...resume.params)
      conditions.push(resume.sql)
    }
    params.push(remaining)

    const transactions = await db.query(
      `SELECT * FROM public.usage_credit_transactions
       WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at ASC, id ASC
       LIMIT $${params.length}`,
      params,
    ).then(result => result.rows, (error) => {
      throw new Error(`Failed to fetch usage credit transactions: ${errorMessage(error)}`)
    })

    if (transactions.length === 0)
      break

    const overageIds = Array.from(new Set(
      transactions
        .map(transaction => getCreditUsageSourceRefOverageEventId(transaction.source_ref))
        .filter((id): id is string => !!id),
    ))

    const overageById = new Map<string, UsageOverageEventRow>()
    for (let index = 0; index < overageIds.length; index += batchSize) {
      const ids = overageIds.slice(index, index + batchSize)
      const overageEvents = await db.query<UsageOverageEventRow>(
        'SELECT * FROM public.usage_overage_events WHERE id = ANY($1)',
        [ids],
      ).then(result => result.rows, (error) => {
        throw new Error(`Failed to fetch usage overage events: ${errorMessage(error)}`)
      })

      for (const overageEvent of overageEvents)
        overageById.set(overageEvent.id, overageEvent)
    }

    for (const transaction of transactions) {
      const overageId = getCreditUsageSourceRefOverageEventId(transaction.source_ref)
      const input = addBackfillRunTags(
        buildCreditUsagePosthogEventInput(transaction, overageId ? overageById.get(overageId) ?? null : null, 'backfill'),
        {
          backfillRangeFrom: fromIso,
          backfillRangeTo: toIso,
          backfillRunId,
          backfillStartedAt,
        },
      )
      seen += 1
      byType.set(String(input.tags.transaction_type), (byType.get(String(input.tags.transaction_type)) ?? 0) + 1)
      byMetric.set(String(input.tags.metric ?? 'none'), (byMetric.get(String(input.tags.metric ?? 'none')) ?? 0) + 1)

      if (!apply) {
        if (seen <= 5)
          console.log('dry-run sample', JSON.stringify({ distinctId: input.distinctId, event: input.event, tags: input.tags, timestamp: input.timestamp }))
        skipped += 1
        continue
      }

      await sendPosthogEvent(posthogUrl, posthogApiKey, input)
      sent += 1
    }

    const lastTransaction = transactions[transactions.length - 1]
    resumeOccurredAt = normalizeIsoDate(lastTransaction.occurred_at, 'transaction occurred_at')
    resumeId = Number(lastTransaction.id)

    if (apply) {
      await saveBackfillProgress(db, {
        cutover_at: cutoverIso,
        job_name: CREDIT_USAGE_BACKFILL_JOB_NAME,
        last_processed_id: resumeId,
        last_processed_occurred_at: resumeOccurredAt,
        scope_key: scopeKey,
      })
    }

    if (transactions.length < remaining)
      break
  }
  await db.end()

  console.log(JSON.stringify({
    apply,
    by_metric: Object.fromEntries(byMetric.entries()),
    by_type: Object.fromEntries(byType.entries()),
    seen,
    sent,
    skipped,
  }, null, 2))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
