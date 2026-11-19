import type { DeploymentState, Environment, Evidence } from './deployment-state.ts'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { z } from 'zod'
import { requiresSchemaTypesSync, resolveDeployScopeFromGit } from './deploy-scope.ts'
import { beginDeployment, completedDeploymentKeys, completeDeployment, emptyState, evidenceSchema, jobSchema, keysForEnvironment, pluginMatrix, stateSchema } from './deployment-state.ts'
import { resolveDeployTag } from './resolve-deploy-tag.ts'

export type Git = (args: string[], input?: string) => string
export type ActionsApi = (path: string) => unknown
const runGit: Git = (args, input) => execFileSync('git', args, {
  input,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: 'github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: 'github-actions[bot]@users.noreply.github.com' },
}).trim()
const actionsApi: ActionsApi = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const oidSchema = z.string().regex(/^[a-f0-9]{40}$/)
export interface StateSnapshot { oid: string | null, state: DeploymentState }
export function stateRef(environment: Environment): string {
  return `refs/heads/deployment-state-${environment}`
}

export function readState(environment: Environment, git: Git = runGit): StateSnapshot {
  const ref = stateRef(environment)
  const remote = git(['ls-remote', '--refs', 'origin', ref])
  if (!remote)
    return { oid: null, state: emptyState(environment) }
  const oid = oidSchema.parse(remote.split(/\s/)[0])
  git(['fetch', '--no-tags', 'origin', oid])
  const state = stateSchema.parse(JSON.parse(git(['show', `${oid}:manifest.json`])))
  if (state.environment !== environment)
    throw new Error('Deployment state environment mismatch')
  return { oid, state }
}

// Plumbing never changes the source checkout or its index. A rejected lease is a
// hard failure: recomputing scope/merging stale completion evidence is unsafe.
export function writeState(snapshot: StateSnapshot, state: DeploymentState, git: Git = runGit): string {
  stateSchema.parse(state)
  const ref = stateRef(state.environment)
  const remote = git(['ls-remote', '--refs', 'origin', ref])
  const actual = remote ? oidSchema.parse(remote.split(/\s/)[0]) : null
  if (actual !== snapshot.oid)
    throw new Error('Deployment state CAS conflict: expected ref changed')
  if (snapshot.state.environment !== state.environment)
    throw new Error('Cannot change deployment state environment')
  const blob = oidSchema.parse(git(['hash-object', '-w', '--stdin'], `${JSON.stringify(state, null, 2)}\n`))
  const tree = oidSchema.parse(git(['mktree'], `100644 blob ${blob}\tmanifest.json\n`))
  const commit = oidSchema.parse(git(['commit-tree', tree, ...(snapshot.oid ? ['-p', snapshot.oid] : []), '-m', 'chore: record deployment evidence']))
  git(['push', `--force-with-lease=${ref}:${snapshot.oid ?? ''}`, 'origin', `${commit}:${ref}`])
  return commit
}

export function readAttemptJobs(api: ActionsApi, repository: string, runId: string, attempt: number) {
  const jobs = []
  for (let page = 1; page <= 3; page++) {
    const result = z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(jobSchema) }).parse(
      api(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`),
    )
    jobs.push(...result.jobs)
    if (jobs.length >= result.total_count)
      return jobs
    if (result.jobs.length === 0)
      throw new Error('Deployment job history is incomplete')
  }
  throw new Error('Deployment job history exceeds the 300-job bound')
}

const historyRunSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_branch: z.string().nullable(),
  head_sha: oidSchema,
  status: z.string(),
  event: z.string(),
})

// Historical jobs can supply evidence, but cannot prove readiness: retained
// history omits expired runs and old-created reruns can finish out of order.
// Keep every recovered entry unresolved until this workflow reconciles it.
export function bootstrapState(environment: Environment, repository: string, currentRunId: string, api: ActionsApi = actionsApi, git: Git = runGit): DeploymentState {
  const state = emptyState(environment)
  let inspected = 0
  for (let page = 1; page <= 2; page++) {
    const result = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(historyRunSchema) }).parse(
      api(`repos/${repository}/actions/workflows/build_and_deploy.yml/runs?event=push&per_page=10&page=${page}`),
    )
    inspected += result.workflow_runs.length
    for (const run of result.workflow_runs) {
      if (`${run.id}` === currentRunId || run.status !== 'completed' || run.event !== 'push' || run.run_attempt !== 1 || !run.head_branch)
        continue
      // Pre-contract reruns have no trustworthy resolved target identity.
      // Only initial attempts of the explicitly pinned historical workflow qualify.
      let target
      try {
        target = resolveDeployTag(run.head_branch, git)
        const workflow = git(['show', `${target.sha}:.github/workflows/build_and_deploy.yml`])
        if (target.sha !== run.head_sha || target.isAlpha !== (environment === 'alpha')
          || !workflow.includes('resolve-deploy-tag.ts --resolve "' + '$' + '{{ github.ref_name }}"')) {
          continue
        }
      }
      catch {
        continue
      }
      const jobs = readAttemptJobs(api, repository, `${run.id}`, 1)
      const evidence: Evidence = { tag: target.tag, sha: target.sha, runId: `${run.id}`, attempt: 1 }
      for (const key of completedDeploymentKeys(jobs, environment)) {
        const previous = state.entries[key]?.success
        // Never order deployments by Actions run creation or numeric run ID.
        if (!previous || isAncestor(previous.sha, evidence.sha, git))
          state.entries[key] = { success: evidence, pending: evidence }
      }
    }
    if (inspected >= result.total_count || result.workflow_runs.length === 0)
      break
  }
  console.error(`Bootstrap inspected ${inspected} retained runs (maximum 20). Historical evidence remains unresolved; missing history forces reconciliation.`)
  return stateSchema.parse(state)
}

function isAncestor(base: string, head: string, git: Git): boolean {
  // merge-base errors (missing objects, unrelated history) must not become a skip.
  return git(['merge-base', base, head]) === base
}

export function validateStateTargets(state: DeploymentState, git: Git = runGit): void {
  for (const entry of Object.values(state.entries)) {
    for (const evidence of [entry.success, entry.pending]) {
      if (evidence && resolveDeployTag(evidence.tag, git).sha !== evidence.sha)
        throw new Error('Deployment evidence tag/SHA mismatch')
    }
  }
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode !== 'begin' && mode !== 'complete')
    throw new Error('Usage: bun scripts/deploy-state.ts <begin|complete>')
  const evidence = evidenceSchema.parse({
    tag: process.env.DEPLOY_TAG,
    sha: process.env.DEPLOY_SHA,
    runId: process.env.GITHUB_RUN_ID,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  })
  const target = resolveDeployTag(evidence.tag)
  if (target.sha !== evidence.sha)
    throw new Error('Resolved deployment tag/SHA mismatch')
  const environment = target.isAlpha ? 'alpha' : 'stable'
  const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/).parse(process.env.GITHUB_REPOSITORY)
  const snapshot = readState(environment)
  if (mode === 'begin') {
    const state = snapshot.oid === null ? bootstrapState(environment, repository, evidence.runId) : snapshot.state
    validateStateTargets(state)
    const result = resolveDeployScopeFromGit(evidence.sha, state)
    const keys = keysForEnvironment(environment).filter(key => result.scope[key.startsWith('plugins_') ? 'plugins' : z.enum(['supabase', 'api', 'translation', 'files', 'gotrue']).parse(key)])
    const next = beginDeployment(state, evidence, keys, (base, head) => isAncestor(base, head, runGit))
    const oid = writeState(snapshot, next)
    console.log(`state_oid=${oid}`)
    console.log(`plugin_matrix=${JSON.stringify(pluginMatrix(environment))}`)
    for (const [key, value] of Object.entries(result.scope))
      console.log(`${key}=${value}`)
    console.log(`requires_schema_types_sync=${requiresSchemaTypesSync(result)}`)
  }
  else {
    const expected = oidSchema.parse(process.env.DEPLOY_STATE_OID)
    if (snapshot.oid !== expected)
      throw new Error('Deployment state CAS conflict: scope attempt is stale; rerun ALL jobs')
    const completed = completedDeploymentKeys(readAttemptJobs(actionsApi, repository, evidence.runId, evidence.attempt), environment)
      .filter(key => snapshot.state.entries[key]?.pending !== null && snapshot.state.entries[key]?.pending !== undefined)
    const next = completeDeployment(snapshot.state, evidence, completed)
    if (completed.length > 0)
      writeState(snapshot, next)
    console.error(`Recorded completed operations: ${completed.join(', ') || '<none>'}. Unresolved operations remain pending.`)
  }
}
