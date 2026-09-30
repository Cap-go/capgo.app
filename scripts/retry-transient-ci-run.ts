import { spawnSync } from 'node:child_process'
import { argv, env, exit } from 'node:process'
import { getTransientSupabaseStartFailure } from './supabase-worktree'

export type TransientCiJobFailure = 'runner_shutdown' | 'supabase_docker_image_pull' | 'supabase_docker_port_bind'

interface WorkflowJobStep {
  conclusion: string | null
  name: string
}

interface WorkflowJob {
  conclusion: string | null
  id: number
  name: string
  steps?: WorkflowJobStep[]
}

interface WorkflowJobsResponse {
  jobs: WorkflowJob[]
}

interface WorkflowRunResponse {
  conclusion: string | null
  run_attempt: number
  status: string
}

const RUNNER_SHUTDOWN = /The runner has received a shutdown signal|runner (?:has )?lost communication with the server/i

export function getTransientCiJobFailure(
  output: string,
  failedStepNames: string[],
): TransientCiJobFailure | null {
  if (RUNNER_SHUTDOWN.test(output))
    return 'runner_shutdown'

  if (!failedStepNames.some(name => /Supabase Start/i.test(name)))
    return null

  const startupFailure = getTransientSupabaseStartFailure(output)
  if (startupFailure === 'docker_image_pull')
    return 'supabase_docker_image_pull'
  if (startupFailure === 'docker_port_bind')
    return 'supabase_docker_port_bind'
  return null
}

function runGh(args: string[]): string {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env,
    maxBuffer: 50 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`gh ${args.join(' ')} failed: ${details}`)
  }
  return result.stdout
}

function readJson<T>(args: string[]): T {
  return JSON.parse(runGh(args)) as T
}

function main(): void {
  const [repository, runId] = argv.slice(2)
  if (!repository || !runId || !/^\d+$/.test(runId)) {
    console.error('Usage: bun scripts/retry-transient-ci-run.ts <owner/repository> <run-id>')
    exit(2)
  }

  const run = readJson<WorkflowRunResponse>(['api', `repos/${repository}/actions/runs/${runId}`])
  if (run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'failure') {
    console.log(`Run ${runId} is not an eligible first-attempt failure; no retry requested.`)
    return
  }

  const jobs = readJson<WorkflowJobsResponse>([
    'api',
    `repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
  ]).jobs
  const failedJobs = jobs.filter(job => job.conclusion === 'failure')
  if (failedJobs.length === 0) {
    console.log(`Run ${runId} has no failed jobs to classify; no retry requested.`)
    return
  }

  const classifications = failedJobs.map((job) => {
    const log = runGh(['api', `repos/${repository}/actions/jobs/${job.id}/logs`])
    const failedStepNames = job.steps?.filter(step => step.conclusion === 'failure').map(step => step.name) ?? []
    return {
      failure: getTransientCiJobFailure(log, failedStepNames),
      job,
    }
  })

  for (const { failure, job } of classifications)
    console.log(`${job.name}: ${failure ?? 'not_transient'}`)

  if (classifications.some(({ failure }) => failure === null)) {
    console.log(`Run ${runId} includes a non-transient failure; no jobs will be retried.`)
    return
  }

  runGh(['api', '--method', 'POST', `repos/${repository}/actions/runs/${runId}/rerun-failed-jobs`])
  console.log(`Requested one retry of all failed jobs in run ${runId}.`)
}

if (import.meta.main) {
  try {
    main()
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    exit(1)
  }
}
