/*
 * Backfill public.users.github_id from existing GitHub usernames.
 *
 * Dry run:
 *   bun run admin:backfill-github-user-ids
 *
 * Apply:
 *   bun run admin:backfill-github-user-ids --apply
 *
 * Optional:
 *   bun run admin:backfill-github-user-ids --apply --limit=100
 *   bun run admin:backfill-github-user-ids --cursor=<user-uuid>
 *   bun run admin:backfill-github-user-ids --env-file=./internal/cloudflare/.env.preprod
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { createSupabaseServiceClient, DEFAULT_ENV_FILE, getArgValue, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const DEFAULT_PAGE_SIZE = 100
const DEFAULT_DELAY_MS = 100
const DEFAULT_REPORT_FILE = './tmp/github_user_id_backfill_report.json'
const GITHUB_API_URL = 'https://api.github.com'

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>

interface CandidateUser {
  github_id: number | null
  github_username: string | null
  id: string
}

interface GitHubUser {
  id: number
  login: string
}

interface BackfillFailure {
  githubUsername: string
  message: string
  userId: string
}

interface BackfillNotFound {
  githubUsername: string
  userId: string
}

interface BackfillResult {
  githubId: number
  githubUsername: string
  status: 'dry_run' | 'updated' | 'skipped_after_recheck'
  userId: string
}

function printHelp() {
  console.log(`Backfill public.users.github_id from existing GitHub usernames.

Usage:
  bun run admin:backfill-github-user-ids [options]

Options:
  --apply                 Update only rows still missing github_id. Default: dry run.
  --limit=N               Process at most N users. Default: all candidates.
  --cursor=UUID           Resume after a public.users.id cursor.
  --delay-ms=N            Delay between GitHub calls. Default: ${DEFAULT_DELAY_MS}.
  --env-file=PATH         Env file to load. Default: ${DEFAULT_ENV_FILE}.
  --report-file=PATH      JSON report output. Default: ${DEFAULT_REPORT_FILE}.
  --help                  Show this help.

Required env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

Optional env:
  GITHUB_TOKEN             Raises GitHub's API rate limit from 60 to 5,000 requests/hour.

The script does not write usernames and never overwrites an existing github_id.`)
}

function parseNonNegativeInteger(value: string | null, label: string, fallback: number) {
  if (value === null)
    return fallback

  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative integer`)
  return parsed
}

function getGitHubToken(env: Record<string, string | undefined>) {
  return process.env.GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || null
}

async function sleep(ms: number) {
  if (ms > 0)
    await new Promise(resolve => setTimeout(resolve, ms))
}

async function lookupGitHubUser(username: string, token: string | null): Promise<GitHubUser | null> {
  const response = await fetch(`${GITHUB_API_URL}/users/${encodeURIComponent(username)}`, {
    headers: {
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (response.status === 404)
    return null

  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    const reset = response.headers.get('x-ratelimit-reset')
    const resetHint = reset ? `; resets at ${new Date(Number(reset) * 1000).toISOString()}` : ''
    throw new Error(`GitHub rate limit reached${resetHint}`)
  }

  if (!response.ok)
    throw new Error(`GitHub lookup failed with HTTP ${response.status}`)

  const data = await response.json() as Partial<GitHubUser>
  if (!data || typeof data.id !== 'number' || typeof data.login !== 'string')
    throw new Error('GitHub returned an invalid user profile')

  return { id: data.id, login: data.login }
}

async function getCandidatePage(client: SupabaseClient, cursor: string | null, pageSize: number) {
  let query = client
    .from('users')
    .select('id, github_username, github_id')
    .not('github_username', 'is', null)
    .is('github_id', null)
    .order('id', { ascending: true })
    .limit(pageSize)

  if (cursor)
    query = query.gt('id', cursor)

  const { data, error } = await query
  if (error)
    throw new Error(`Failed to load candidates: ${error.message}`)
  return (data ?? []) as CandidateUser[]
}

async function updateGithubId(client: SupabaseClient, candidate: CandidateUser, githubId: number) {
  const { data, error } = await client
    .from('users')
    .update({ github_id: githubId })
    .eq('id', candidate.id)
    .eq('github_username', candidate.github_username!)
    .is('github_id', null)
    .select('id')
    .maybeSingle()

  if (error)
    throw new Error(`Failed to update ${candidate.id}: ${error.message}`)
  return !!data
}

async function writeReport(filePath: string, report: unknown) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    printHelp()
    return
  }

  const apply = args.includes('--apply')
  const envFile = getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE
  const reportFile = getArgValue(args, '--report-file') ?? DEFAULT_REPORT_FILE
  const cursor = getArgValue(args, '--cursor')
  const limit = parsePositiveInteger(getArgValue(args, '--limit'), '--limit', Number.MAX_SAFE_INTEGER)
  const delayMs = parseNonNegativeInteger(getArgValue(args, '--delay-ms'), '--delay-ms', DEFAULT_DELAY_MS)
  const env = { ...await loadEnv(envFile), ...process.env }
  const client = createSupabaseServiceClient(env)
  const githubToken = getGitHubToken(env)
  const failures: BackfillFailure[] = []
  const notFound: BackfillNotFound[] = []
  const results: BackfillResult[] = []
  let lastCursor = cursor
  let processed = 0
  let stoppedForRateLimit = false

  while (processed < limit) {
    const page = await getCandidatePage(client, lastCursor, Math.min(DEFAULT_PAGE_SIZE, limit - processed))
    if (page.length === 0)
      break

    for (const candidate of page) {
      lastCursor = candidate.id
      processed += 1
      const username = candidate.github_username?.trim()
      if (!username)
        continue

      try {
        const githubUser = await lookupGitHubUser(username, githubToken)
        if (!githubUser) {
          notFound.push({ userId: candidate.id, githubUsername: username })
          continue
        }

        if (!apply) {
          results.push({ userId: candidate.id, githubUsername: githubUser.login, githubId: githubUser.id, status: 'dry_run' })
          continue
        }

        const updated = await updateGithubId(client, candidate, githubUser.id)
        results.push({
          userId: candidate.id,
          githubUsername: githubUser.login,
          githubId: githubUser.id,
          status: updated ? 'updated' : 'skipped_after_recheck',
        })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ userId: candidate.id, githubUsername: username, message })
        if (message.startsWith('GitHub rate limit reached')) {
          stoppedForRateLimit = true
          break
        }
      }
      finally {
        await sleep(delayMs)
      }
    }

    if (stoppedForRateLimit || page.length < Math.min(DEFAULT_PAGE_SIZE, limit - processed))
      break
  }

  const report = {
    mode: apply ? 'apply' : 'dry_run',
    processed,
    updated: results.filter(result => result.status === 'updated').length,
    wouldUpdate: results.filter(result => result.status === 'dry_run').length,
    skippedAfterRecheck: results.filter(result => result.status === 'skipped_after_recheck').length,
    notFound,
    failures,
    lastCursor,
    stoppedForRateLimit,
  }
  await writeReport(reportFile, report)
  console.log(JSON.stringify(report, null, 2))

  if (stoppedForRateLimit)
    process.exitCode = 2
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
