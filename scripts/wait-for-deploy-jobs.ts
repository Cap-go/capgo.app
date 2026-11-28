/**
 * Wait inside a job until other jobs of the same workflow run finish.
 *
 * A job-level `needs` makes a job start only after its dependency finished, so its own setup
 * (checkout, install, downloads) runs after the dependency instead of during it. Jobs that only
 * need the dependency before their first mutating step use this gate instead: they set up in
 * parallel and wait here.
 *
 * Each named job must end as success or skipped, like `needs.<job>.result` checks in an `if`;
 * with --require-success, only success passes. Any other conclusion, or the timeout, fails.
 *
 * Usage: bun scripts/wait-for-deploy-jobs.ts [--require-success] [--timeout-minutes N] "<job name>" ...

 * Reads GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID and GH_TOKEN.
 */
import process from 'node:process'

export interface RunJob {
  name: string
  status: string
  conclusion: string | null
  run_attempt?: number
}

export type GateResult
  = | { state: 'wait', pending: string[] }
    | { state: 'proceed' }
    | { state: 'fail', reason: string }

/** `jobs` is the run's `filter=latest` listing: one entry per job, from its latest attempt. */
export function evaluateGate(jobs: RunJob[], names: string[], options: { requireSuccess?: boolean } = {}): GateResult {
  const passing = new Set(options.requireSuccess ? ['success'] : ['success', 'skipped'])
  const pending: string[] = []
  for (const name of names) {
    const matches = jobs.filter(job => job.name === name)
    if (matches.length > 1)
      return { state: 'fail', reason: `More than one job is named "${name}"` }
    const [job] = matches
    // A job waiting on its own `needs` may not be listed yet.
    if (!job || job.status !== 'completed') {
      pending.push(name)
      continue
    }
    if (!passing.has(job.conclusion ?? ''))
      return { state: 'fail', reason: `"${name}" ended with ${job.conclusion ?? 'no conclusion'}` }
  }
  return pending.length > 0 ? { state: 'wait', pending } : { state: 'proceed' }
}

export function parseGateArgs(argv: string[]) {
  let timeoutMinutes = 45
  let requireSuccess = false
  const names: string[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--require-success') {
      requireSuccess = true
      continue
    }
    if (argv[index] === '--timeout-minutes') {
      timeoutMinutes = Number(argv[++index])
      if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)
        throw new Error('--timeout-minutes must be a positive number')
      continue
    }
    names.push(argv[index])
  }
  if (names.length === 0)
    throw new Error('Name at least one job to wait for')
  return { timeoutMinutes, requireSuccess, names }
}

async function listRunJobs(): Promise<RunJob[]> {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com'
  const repository = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  const token = process.env.GH_TOKEN
  if (!repository || !runId || !token)
    throw new Error('GITHUB_REPOSITORY, GITHUB_RUN_ID and GH_TOKEN are required')
  const jobs: RunJob[] = []
  for (let page = 1; ; page++) {
    const response = await fetch(`${api}/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`, {
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    })
    if (!response.ok)
      throw new Error(`Listing run jobs failed: ${response.status} ${await response.text()}`)
    const body = await response.json() as { jobs: RunJob[], total_count: number }
    jobs.push(...body.jobs)
    if (body.jobs.length < 100 || jobs.length >= body.total_count)
      return jobs
  }
}

async function main() {
  const { timeoutMinutes, requireSuccess, names } = parseGateArgs(process.argv.slice(2))
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMinutes * 60_000
  let lastPending = ''
  let failedListings = 0
  while (true) {
    let result: GateResult
    try {
      result = evaluateGate(await listRunJobs(), names, { requireSuccess })
      failedListings = 0
    }
    catch (error) {
      // Tolerate brief API errors; a persistent one fails the gate.
      if (++failedListings >= 5)
        throw error
      console.warn(`[wait-for-deploy-jobs] ${error instanceof Error ? error.message : String(error)}; retrying`)
      result = { state: 'wait', pending: names }
    }
    if (result.state === 'proceed') {
      console.log(`[wait-for-deploy-jobs] ${names.join(', ')}: ${requireSuccess ? 'success' : 'success or skipped'}`)
      return
    }
    if (result.state === 'fail')
      throw new Error(result.reason)
    const pending = result.pending.join(', ')
    if (pending !== lastPending) {
      console.log(`[wait-for-deploy-jobs] waiting for ${pending}`)
      lastPending = pending
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMinutes} minutes waiting for ${pending}`)
    // Poll often while the dependency is likely about to finish, then back off to stay well
    // inside the GITHUB_TOKEN rate limit during a long replica copy.
    const waited = Date.now() - startedAt
    await new Promise(resolve => setTimeout(resolve, waited < 5 * 60_000 ? 3000 : 15_000))
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
