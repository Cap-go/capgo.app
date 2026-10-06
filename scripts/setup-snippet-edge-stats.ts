#!/usr/bin/env bun
/**
 * Creates the pipeline that carries the stats of snippet edge answers back to
 * the plugin worker (see plugin_runtime/utils/snippetEdgeReplay.ts):
 *
 *   snippet answer (X-Capgo-Edge-Stat)
 *     -> zone Logpush (http_requests + custom response field) -> R2
 *     -> R2 object-create notification -> capgo-snippet-edge-stats-files
 *     -> plugin worker (prod_eu) splits files -> capgo-snippet-edge-stats-replay
 *     -> plugin worker replays each chunk (Analytics Engine writes)
 *
 * Run it once, before deploying a plugin worker whose wrangler config binds
 * these queues and bucket, and before `bun run snippet-edge-answer:set`.
 * Every step is skipped when it already exists.
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN   Logs Edit + Zone Read + Zone WAF/Rulesets Edit (custom log fields)
 *   CLOUDFLARE_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   R2 token able to write the bucket (Logpush destination)
 *   ZONE_NAME              default capgo.app
 *
 *   bun run snippet-edge-stats:setup [--dry-run]
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

export const BUCKET = 'capgo-snippet-edge-stats'
export const FILES_QUEUE = 'capgo-snippet-edge-stats-files'
export const REPLAY_QUEUE = 'capgo-snippet-edge-stats-replay'
export const DLQ = 'capgo-snippet-edge-stats-dlq'
export const LOGPUSH_JOB_NAME = 'capgo-snippet-edge-stats'
export const STAT_HEADER = 'x-capgo-edge-stat'
/** Logpush files are only read once by the replay: keep them a day for debugging. */
const RETENTION_DAYS = 1
const PLUGIN_PATHS = ['/updates', '/stats', '/plugin/updates', '/plugin/stats']

export function logpushJobBody(destination: string) {
  return {
    name: LOGPUSH_JOB_NAME,
    dataset: 'http_requests',
    enabled: true,
    destination_conf: destination,
    max_upload_interval_seconds: 30,
    output_options: {
      output_type: 'ndjson',
      timestamp_format: 'unixnano',
      field_names: ['ClientIP', 'ClientCountry', 'ClientRequestHost', 'ClientRequestPath', 'EdgeStartTimestamp', 'RayID', 'ResponseHeaders'],
    },
    // Only plugin calls; the consumer keeps the lines that carry the stat header.
    filter: JSON.stringify({ where: { or: PLUGIN_PATHS.map(value => ({ key: 'ClientRequestPath', operator: 'eq', value })) } }),
  }
}

interface CustomFieldsRule {
  id?: string
  action: string
  expression: string
  description?: string
  action_parameters?: { response_fields?: { name: string }[] } & Record<string, unknown>
}

/** Adds the stat header to the zone's custom log fields, keeping the fields already configured. */
export function withStatHeaderField(rules: CustomFieldsRule[]) {
  const existing = rules.find(rule => rule.action === 'log_custom_field' && rule.expression === 'true')
  if (!existing) {
    return [...rules, {
      action: 'log_custom_field',
      expression: 'true',
      description: 'Capgo log fields',
      action_parameters: { response_fields: [{ name: STAT_HEADER }] },
    }]
  }
  const fields = existing.action_parameters?.response_fields ?? []
  if (fields.some(field => field.name.toLowerCase() === STAT_HEADER))
    return rules
  return rules.map(rule => rule === existing
    ? { ...rule, action_parameters: { ...rule.action_parameters, response_fields: [...fields, { name: STAT_HEADER }] } }
    : rule)
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value)
    throw new Error(`Missing ${name}`)
  return value
}

function wrangler(args: string[], dryRun: boolean, alreadyExists: RegExp) {
  console.log(`$ wrangler ${args.join(' ')}`)
  if (dryRun)
    return
  const child = spawnSync('bunx', ['wrangler', ...args], { encoding: 'utf8' })
  const output = `${child.stdout}${child.stderr}`
  if (child.status !== 0 && !alreadyExists.test(output)) {
    console.error(output)
    throw new Error(`wrangler ${args.join(' ')} failed`)
  }
}

async function cloudflare<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${requireEnv('CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json', ...init.headers },
  })
  const json = await response.json() as { success: boolean, result: T, errors?: unknown }
  if (!json.success)
    throw new Error(`${init.method ?? 'GET'} ${path}: ${JSON.stringify(json.errors)}`)
  return json.result
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID')
  const zoneName = process.env.ZONE_NAME?.trim() || 'capgo.app'

  const exists = /already exists|already been taken|10004|11009/i
  wrangler(['r2', 'bucket', 'create', BUCKET], dryRun, exists)
  wrangler(['r2', 'bucket', 'lifecycle', 'add', BUCKET, 'expire-logpush', '--expire-days', String(RETENTION_DAYS), '--force'], dryRun, exists)
  for (const queue of [DLQ, FILES_QUEUE, REPLAY_QUEUE])
    wrangler(['queues', 'create', queue], dryRun, exists)
  wrangler(['r2', 'bucket', 'notification', 'create', BUCKET, '--event-type', 'object-create', '--queue', FILES_QUEUE, '--description', 'Logpush files to replay'], dryRun, exists)

  const destination = `r2://${BUCKET}/{DATE}?account-id=${accountId}&access-key-id=${requireEnv('R2_ACCESS_KEY_ID')}&secret-access-key=${requireEnv('R2_SECRET_ACCESS_KEY')}`
  if (dryRun) {
    console.log(`Would add response field ${STAT_HEADER} to ${zoneName} custom log fields`)
    console.log(`Would create Logpush job ${JSON.stringify({ ...logpushJobBody('r2://<redacted>'), destination_conf: undefined })}`)
    return
  }

  const [zone] = await cloudflare<{ id: string }[]>(`/zones?name=${encodeURIComponent(zoneName)}`)
  if (!zone)
    throw new Error(`Zone ${zoneName} not found`)

  // Custom log fields live in the zone's http_log_custom_fields ruleset: merge, never replace.
  let rules: CustomFieldsRule[] = []
  try {
    rules = (await cloudflare<{ rules?: CustomFieldsRule[] }>(`/zones/${zone.id}/rulesets/phases/http_log_custom_fields/entrypoint`)).rules ?? []
  }
  catch {
    // No custom fields configured yet.
  }
  const nextRules = withStatHeaderField(rules)
  if (nextRules !== rules) {
    await cloudflare(`/zones/${zone.id}/rulesets/phases/http_log_custom_fields/entrypoint`, {
      method: 'PUT',
      body: JSON.stringify({ rules: nextRules }),
    })
    console.log(`Added ${STAT_HEADER} to the ${zoneName} custom log fields`)
  }

  const jobs = await cloudflare<{ id: number, name: string }[]>(`/zones/${zone.id}/logpush/jobs`)
  if (jobs.some(job => job.name === LOGPUSH_JOB_NAME)) {
    console.log(`Logpush job ${LOGPUSH_JOB_NAME} already exists`)
    return
  }
  const job = await cloudflare<{ id: number }>(`/zones/${zone.id}/logpush/jobs`, {
    method: 'POST',
    body: JSON.stringify(logpushJobBody(destination)),
  })
  console.log(`Created Logpush job ${LOGPUSH_JOB_NAME} (${job.id})`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
