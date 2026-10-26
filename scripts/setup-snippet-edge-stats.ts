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
 * The queue consumers are attached to the existing EU worker here.
 * Run it once, before deploying a plugin worker whose wrangler config binds
 * these queues and bucket, and before `bun run snippet-edge-answer:set`.
 * Every step is skipped when it already exists; an existing Logpush job is
 * updated when its settings differ.
 *
 * Env (unset values come from internal/cloudflare/.env.prod, or ENV_FILE):
 *   CLOUDFLARE_API_TOKEN   Logs Edit + Zone Read + Zone WAF/Rulesets Edit (custom log fields)
 *                          + Account API Tokens Edit (Logpush R2 key), else CF_ANALYTICS_TOKEN.
 *                          When exported, wrangler uses it too and then also needs
 *                          Workers R2 Storage Write + Queues Write.
 *   CLOUDFLARE_ACCOUNT_ID  else CF_ACCOUNT_ANALYTICS_ID
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   optional R2 key for the Logpush destination; by
 *                          default the setup creates LOGPUSH_R2_TOKEN_NAME, scoped to the bucket.
 *                          Keep that key: Logpush writes every file with it.
 *   ZONE_NAME              default capgo.app
 * Without an exported token, the R2 bucket and queues are created with the wrangler login.
 *
 *   bun run snippet-edge-stats:setup [--dry-run]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { parseJsonc, WRANGLER_PATH } from './generate-plugin-route-hosts.ts'

export const BUCKET = 'capgo-snippet-edge-stats'
export const FILES_QUEUE = 'capgo-snippet-edge-stats-files'
export const REPLAY_QUEUE = 'capgo-snippet-edge-stats-replay'
export const DLQ = 'capgo-snippet-edge-stats-dlq'
export const LOGPUSH_JOB_NAME = 'capgo-snippet-edge-stats'
export const STAT_HEADER = 'x-capgo-edge-stat'
export const LOGPUSH_R2_TOKEN_NAME = 'capgo-snippet-edge-stats-logpush (R2 write, used by Logpush, do not delete)'
const R2_BUCKET_ITEM_WRITE = '2efd5506f9c8494dacb1fa10a3e7d5b6'
/** The replay deletes each file once queued: the lifecycle only clears files it never read. */
const RETENTION_DAYS = 1
const PLUGIN_PATHS = ['/updates', '/stats', '/plugin/updates', '/plugin/stats']

export function logpushJobBody(destination: string) {
  return {
    name: LOGPUSH_JOB_NAME,
    dataset: 'http_requests',
    enabled: true,
    destination_conf: destination,
    max_upload_interval_seconds: 30,
    // The consumer holds a whole file in memory (128 MB): the 100k-line default would not fit.
    max_upload_bytes: 5_000_000,
    max_upload_records: 10_000,
    output_options: {
      output_type: 'ndjson',
      timestamp_format: 'unixnano',
      field_names: ['ClientIP', 'ClientCountry', 'ClientASN', 'ClientRequestHost', 'ClientRequestPath', 'EdgeStartTimestamp', 'RayID', 'ResponseHeaders'],
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

const DEFAULT_ENV_FILE = new URL('../internal/cloudflare/.env.prod', import.meta.url).pathname

/** KEY=VALUE lines of a dotenv file; comments, blanks and other lines are skipped. */
export function parseEnvFile(text: string) {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([\w.]+)\s*=(.*)$/.exec(line)
    if (!match)
      continue
    const raw = match[2]!.trim()
    const quoted = /^(['"])(.*)\1$/.exec(raw)
    values[match[1]!] = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '')
  }
  return values
}

export interface SetupEnv {
  accountId: string
  apiToken: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  zoneName: string
}

/** The process env first, then the names the prod env file uses for the same values. */
export function resolveSetupEnv(env: Record<string, string | undefined>, file: Record<string, string>): SetupEnv {
  const pick = (...values: (string | undefined)[]) => values.map(value => value?.trim()).find(Boolean) ?? ''
  return {
    accountId: pick(env.CLOUDFLARE_ACCOUNT_ID, file.CLOUDFLARE_ACCOUNT_ID, file.CF_ACCOUNT_ANALYTICS_ID),
    apiToken: pick(env.CLOUDFLARE_API_TOKEN, file.CLOUDFLARE_API_TOKEN, file.CF_ANALYTICS_TOKEN),
    // Not the S3_* keys of the env file: they are scoped to other buckets.
    r2AccessKeyId: pick(env.R2_ACCESS_KEY_ID),
    r2SecretAccessKey: pick(env.R2_SECRET_ACCESS_KEY),
    zoneName: pick(env.ZONE_NAME, file.ZONE_NAME) || 'capgo.app',
  }
}

/** The env file is gitignored: a worktree only has it in the main checkout. */
function mainCheckoutEnvFile() {
  const child = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  return child.status === 0 ? `${child.stdout.trim().replace(/\/\.git$/, '')}/internal/cloudflare/.env.prod` : ''
}

function readEnvFile() {
  const path = [process.env.ENV_FILE?.trim(), DEFAULT_ENV_FILE, mainCheckoutEnvFile()].find(candidate => candidate && existsSync(candidate))
  if (!path)
    return {}
  console.log(`Reading unset values from ${path}`)
  return parseEnvFile(readFileSync(path, 'utf8'))
}

function required(value: string, names: string) {
  if (!value)
    throw new Error(`Missing ${names}`)
  return value
}

let apiToken = ''
let wranglerEnv: NodeJS.ProcessEnv = process.env

function wrangler(args: string[], dryRun: boolean, alreadyExists: RegExp) {
  console.log(`$ wrangler ${args.join(' ')}`)
  if (dryRun)
    return
  const child = spawnSync('bunx', ['wrangler', ...args], { encoding: 'utf8', env: wranglerEnv })
  const output = `${child.stdout}${child.stderr}`
  if (child.status !== 0 && !alreadyExists.test(output)) {
    console.error(output)
    throw new Error(`wrangler ${args.join(' ')} failed`)
  }
}

class CloudflareApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function cloudflare<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${required(apiToken, 'CLOUDFLARE_API_TOKEN (or CF_ANALYTICS_TOKEN in the env file)')}`, 'Content-Type': 'application/json', ...init.headers },
  })
  const json = await response.json().catch(() => null) as { success: boolean, result: T, errors?: unknown } | null
  if (!json?.success) {
    const hint = response.status === 403 ? ' (export a CLOUDFLARE_API_TOKEN with Zone Read + Logs Edit + Zone WAF Edit on the zone, and Account API Tokens Edit)' : ''
    throw new CloudflareApiError(`${init.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(json?.errors ?? null)}${hint}`, response.status)
  }
  return json.result
}

interface LogpushJob {
  id: number
  name: string
  enabled?: boolean
  filter?: string | null
  max_upload_interval_seconds?: number
  max_upload_bytes?: number
  max_upload_records?: number
  output_options?: { output_type?: string, timestamp_format?: string, field_names?: string[] } | null
}

/** True when the job lacks a setting of logpushJobBody (destination aside: the API hides its secrets). */
export function logpushJobNeedsUpdate(job: LogpushJob) {
  const wanted = logpushJobBody('')
  const fields = job.output_options?.field_names ?? []
  return job.enabled !== wanted.enabled
    || job.filter !== wanted.filter
    || job.max_upload_interval_seconds !== wanted.max_upload_interval_seconds
    || job.max_upload_bytes !== wanted.max_upload_bytes
    || job.max_upload_records !== wanted.max_upload_records
    || job.output_options?.output_type !== wanted.output_options.output_type
    || job.output_options?.timestamp_format !== wanted.output_options.timestamp_format
    || wanted.output_options.field_names.some(field => !fields.includes(field))
}

const CONSUMER_ENV = 'prod_eu'

interface QueueConsumer {
  queue: string
  max_batch_size?: number
  max_batch_timeout?: number
  max_retries?: number
  dead_letter_queue?: string
}

/**
 * `wrangler queues consumer add` for each stats queue consumer of the plugin
 * worker config: the EU deploy (`versions deploy`) does not attach them.
 */
export function consumerAddArgs(config: unknown, envName = CONSUMER_ENV) {
  const env = (config as { env?: Record<string, { name?: string, queues?: { consumers?: QueueConsumer[] } }> }).env?.[envName]
  if (!env?.name)
    throw new Error(`No ${envName} env in ${WRANGLER_PATH}`)
  return (env.queues?.consumers ?? [])
    .filter(consumer => consumer.queue === FILES_QUEUE || consumer.queue === REPLAY_QUEUE)
    .map(consumer => [
      'queues',
      'consumer',
      'add',
      consumer.queue,
      env.name!,
      ...(consumer.max_batch_size === undefined ? [] : ['--batch-size', String(consumer.max_batch_size)]),
      ...(consumer.max_batch_timeout === undefined ? [] : ['--batch-timeout', String(consumer.max_batch_timeout)]),
      ...(consumer.max_retries === undefined ? [] : ['--message-retries', String(consumer.max_retries)]),
      ...(consumer.dead_letter_queue ? ['--dead-letter-queue', consumer.dead_letter_queue] : []),
    ])
}

/** R2 S3 credentials of an API token: its ID, and the SHA-256 of its value. */
export function r2CredentialsOfToken(token: { id: string, value: string }) {
  return { accessKeyId: token.id, secretAccessKey: createHash('sha256').update(token.value).digest('hex') }
}

/** An account API token that can only write the stats bucket: the Logpush destination key. */
async function createLogpushR2Key(accountId: string) {
  const resource = `com.cloudflare.edge.r2.bucket.${accountId}_default_${BUCKET}`
  const token = await cloudflare<{ id: string, value: string }>(`/accounts/${accountId}/tokens`, {
    method: 'POST',
    body: JSON.stringify({
      name: LOGPUSH_R2_TOKEN_NAME,
      policies: [{ effect: 'allow', permission_groups: [{ id: R2_BUCKET_ITEM_WRITE }], resources: { [resource]: '*' } }],
    }),
  })
  console.log(`Created R2 key ${token.id} (${LOGPUSH_R2_TOKEN_NAME})`)
  return r2CredentialsOfToken(token)
}

/** A new key can take a few seconds to reach R2: Logpush checks the destination by writing to it. */
async function createLogpushJob(zoneId: string, destination: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await cloudflare<{ id: number }>(`/zones/${zoneId}/logpush/jobs`, {
        method: 'POST',
        body: JSON.stringify(logpushJobBody(destination)),
      })
    }
    catch (error) {
      if (attempt >= 6 || !(error instanceof Error && error.message.includes('error validating destination')))
        throw error
      await new Promise(resolve => setTimeout(resolve, 10_000))
    }
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const setup = resolveSetupEnv(process.env, readEnvFile())
  const accountId = required(setup.accountId, 'CLOUDFLARE_ACCOUNT_ID (or CF_ACCOUNT_ANALYTICS_ID in the env file)')
  const zoneName = setup.zoneName
  apiToken = setup.apiToken
  // wrangler picks the account from its login, which may see several.
  wranglerEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId }

  // A previous run left these: 10061 lifecycle rule, 11020 bucket notification (overlap), 11004 queue consumer.
  const exists = /already exists|already been taken|10004|11009|10061|11020|11004/i
  wrangler(['r2', 'bucket', 'create', BUCKET], dryRun, exists)
  wrangler(['r2', 'bucket', 'lifecycle', 'add', BUCKET, 'expire-logpush', '--expire-days', String(RETENTION_DAYS), '--force'], dryRun, exists)
  for (const queue of [DLQ, FILES_QUEUE, REPLAY_QUEUE])
    wrangler(['queues', 'create', queue], dryRun, exists)
  wrangler(['r2', 'bucket', 'notification', 'create', BUCKET, '--event-type', 'object-create', '--queue', FILES_QUEUE, '--description', 'Logpush files to replay'], dryRun, exists)
  for (const args of consumerAddArgs(parseJsonc(readFileSync(WRANGLER_PATH, 'utf8'))))
    wrangler(args, dryRun, exists)

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
  catch (error) {
    // Only a missing entrypoint means "no custom fields yet": on any other
    // error the PUT below would replace the fields already configured.
    if (!(error instanceof CloudflareApiError && error.status === 404))
      throw error
  }
  const nextRules = withStatHeaderField(rules)
  if (nextRules !== rules) {
    await cloudflare(`/zones/${zone.id}/rulesets/phases/http_log_custom_fields/entrypoint`, {
      method: 'PUT',
      body: JSON.stringify({ rules: nextRules }),
    })
    console.log(`Added ${STAT_HEADER} to the ${zoneName} custom log fields`)
  }

  const jobs = await cloudflare<LogpushJob[]>(`/zones/${zone.id}/logpush/jobs`)
  const existing = jobs.find(job => job.name === LOGPUSH_JOB_NAME)
  if (existing) {
    if (!logpushJobNeedsUpdate(existing)) {
      console.log(`Logpush job ${LOGPUSH_JOB_NAME} already exists`)
      return
    }
    // No destination_conf: the job keeps its R2 key.
    const { name: _name, destination_conf: _destination, ...settings } = logpushJobBody('')
    await cloudflare(`/zones/${zone.id}/logpush/jobs/${existing.id}`, { method: 'PUT', body: JSON.stringify(settings) })
    console.log(`Updated Logpush job ${LOGPUSH_JOB_NAME} (${existing.id})`)
    return
  }
  const key = setup.r2AccessKeyId && setup.r2SecretAccessKey
    ? { accessKeyId: setup.r2AccessKeyId, secretAccessKey: setup.r2SecretAccessKey }
    : await createLogpushR2Key(accountId)
  const destination = `r2://${BUCKET}/{DATE}?account-id=${accountId}&access-key-id=${key.accessKeyId}&secret-access-key=${key.secretAccessKey}`
  const job = await createLogpushJob(zone.id, destination)
  console.log(`Created Logpush job ${LOGPUSH_JOB_NAME} (${job.id})`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
