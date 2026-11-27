import type { ActionsApi, Git } from '../scripts/deploy-state.ts'
import type { DeploymentJob, DeploymentState, Evidence } from '../scripts/deployment-state.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { resolveDeployScopeFromGit } from '../scripts/deploy-scope.ts'
import { bootstrapState, readAttemptJobs, readState, validateStateTargets, writeState } from '../scripts/deploy-state.ts'
import { beginDeployment, completedDeploymentKeys, completeDeployment, emptyState, keysForEnvironment, pluginMatrix, stateSchema } from '../scripts/deployment-state.ts'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'deployment-state-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const source = join(root, 'source')
  const gitAt = (cwd: string): Git => (args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const rootGit = gitAt(root)
  rootGit(['init', '--bare', remote])
  rootGit(['clone', remote, source])
  const git = gitAt(source)
  git(['config', 'user.name', 'Test'])
  git(['config', 'user.email', 'deployment-test@example.com'])
  const commit = (file: string, contents: string, message = 'test: update source') => {
    mkdirSync(join(source, file, '..'), { recursive: true })
    writeFileSync(join(source, file), contents)
    git(['add', '.'])
    git(['commit', '-m', message])
    return git(['rev-parse', 'HEAD'])
  }
  const sha = commit('README.md', 'Initial source')
  git(['tag', 'capgo-1.0.0'])
  return { root, source, git, commit, sha }
}
const evidence = (sha: string, tag = 'capgo-1.0.0', runId = '10', attempt = 1): Evidence => ({ sha, tag, runId, attempt })
function ready(sha: string, environment: 'stable' | 'alpha' = 'stable'): DeploymentState {
  const state = emptyState(environment)
  for (const key of keysForEnvironment(environment))
    state.entries[key] = { success: evidence(sha, environment === 'alpha' ? 'capgo-1.0.0-alpha.1' : 'capgo-1.0.0'), pending: null }
  return state
}
function job(name: string, steps: string[], conclusion = 'success'): DeploymentJob {
  return {
    name,
    status: 'completed',
    conclusion,
    steps: steps.map(name => ({ name, conclusion: 'success', completed_at: '2026-01-01T00:00:00Z' })),
  }
}
const apiJob = () => job('deploy_api', ['Deploy CF Worker API', 'Retire removed CF Workers'])
const supabaseJob = () => job('Build code and deploy to Supabase', ['Apply Supabase Migrations', 'Update functions'])
const stableSupabaseJob = () => job('Build code and deploy to Supabase', ['Reconcile the Google subscriber through server-side Cloud SQL import', 'Apply Supabase Migrations', 'Update functions'])
const refreshJob = () => job('Refresh production read-replica subscription', ['Require read-replica subscription refresh'])

describe('cumulative deployment scope with real git history', () => {
  it('keeps changes from failed published tags pending on later unrelated tags', () => {
    const repo = repository()
    const state = ready(repo.sha)
    repo.commit('cloudflare_workers/plugin/index.ts', 'plugin change')
    repo.git(['tag', 'capgo-1.1.0'])
    const head = repo.commit('src/view.vue', 'unrelated')
    repo.git(['tag', 'capgo-1.2.0'])
    expect(resolveDeployScopeFromGit(head, state, repo.git).scope).toMatchObject({ plugins: true, api: false, gotrue: false })
    expect(resolveDeployScopeFromGit(head, ready(head), repo.git).scope.plugins).toBe(false)
  })

  it('compares every region and reconciles a partial rollout even after a source revert', () => {
    const repo = repository()
    const state = ready(repo.sha)
    const changed = repo.commit('cloudflare_workers/plugin/index.ts', 'partially deployed')
    const attempt = evidence(changed, 'capgo-1.1.0')
    const pending = beginDeployment(state, attempt, keysForEnvironment('stable').filter(key => key.startsWith('plugins_')), () => true)
    const partial = completeDeployment(pending, attempt, ['plugins_eu', 'plugins_us'])
    repo.git(['revert', '--no-edit', changed])
    const head = repo.git(['rev-parse', 'HEAD'])
    expect(resolveDeployScopeFromGit(head, partial, repo.git).scope.plugins).toBe(true)
    // Even without intents, a per-region baseline sees the reverted partial change.
    const regionOnly = ready(repo.sha)
    regionOnly.entries.plugins_eu = { success: attempt, pending: null }
    expect(resolveDeployScopeFromGit(head, regionOnly, repo.git).scope.plugins).toBe(true)
    // A lost completion job also leaves durable intent, never false readiness.
    expect(resolveDeployScopeFromGit(head, pending, repo.git).scope.plugins).toBe(true)
  })

  it('keeps stable and alpha baselines separate and GoTrue folder-only', () => {
    const repo = repository()
    const head = repo.commit('cloudflare_workers/api/index.ts', 'api')
    expect(resolveDeployScopeFromGit(head, ready(repo.sha), repo.git).scope.gotrue).toBe(false)
    expect(resolveDeployScopeFromGit(head, ready(head, 'alpha'), repo.git).scope.api).toBe(false)
    expect(resolveDeployScopeFromGit(head, ready(repo.sha), repo.git).scope.api).toBe(true)
    const auth = repo.commit('cloudflare_workers/gotrue/index.ts', 'auth')
    expect(resolveDeployScopeFromGit(auth, ready(head), repo.git).scope.gotrue).toBe(true)
    expect(resolveDeployScopeFromGit(auth, ready(head, 'alpha'), repo.git).scope.gotrue).toBe(false)
  })

  it.each([
    ['supabase', 'supabase/config.toml'],
    ['api', 'cloudflare_workers/api/index.ts'],
    ['translation', 'cloudflare_workers/translation/index.ts'],
    ['files', 'cloudflare_workers/files/index.ts'],
    ['plugins', 'cloudflare_workers/plugin/index.ts'],
    ['gotrue', 'cloudflare_workers/gotrue/index.ts'],
  ] as const)('preserves %s matching for deleted files', (target, file) => {
    const repo = repository()
    const base = repo.commit(file, 'remove this deployed source')
    repo.git(['rm', file])
    repo.git(['commit', '-m', 'test: delete deployed source'])
    expect(resolveDeployScopeFromGit(repo.git(['rev-parse', 'HEAD']), ready(base), repo.git).scope[target]).toBe(true)
  })

  it('ignores generated release changes but makes the completed target a no-op on retry', () => {
    const repo = repository()
    repo.commit('package.json', '{"version":"1.0.0"}')
    const base = repo.git(['rev-parse', 'HEAD'])
    repo.commit('src/view.vue', 'frontend')
    const head = repo.commit('package.json', '{"version":"1.0.1"}', 'chore(release): 1.0.1')
    expect(resolveDeployScopeFromGit(head, ready(base), repo.git).scope.api).toBe(false)
    expect(resolveDeployScopeFromGit(head, ready(head), repo.git).scope.api).toBe(false)
  })

  it('forces unknown targets and rejects unreadable git baselines rather than using previous tags', () => {
    const repo = repository()
    expect(Object.values(resolveDeployScopeFromGit(repo.sha, emptyState('stable'), repo.git).scope).every(Boolean)).toBe(true)
    const state = ready('a'.repeat(40))
    expect(() => resolveDeployScopeFromGit(repo.sha, state, repo.git)).toThrow()
  })
})

describe('operation evidence and attempt identity', () => {
  it('records actual successful operations inside a failed workflow, never skipped/skip-only runs', () => {
    expect(completedDeploymentKeys([apiJob()], 'stable')).toEqual(['api'])
    expect(completedDeploymentKeys([{ ...apiJob(), conclusion: 'skipped', steps: [] }], 'stable')).toEqual([])
    expect(completedDeploymentKeys([{ ...apiJob(), conclusion: 'skipped' }], 'stable')).toEqual([])
    expect(completedDeploymentKeys([job('deploy_api', [])], 'stable')).toEqual([])
    const failed = apiJob()
    failed.steps[0].conclusion = 'failure'
    expect(completedDeploymentKeys([failed], 'stable')).toEqual([])
    expect(completedDeploymentKeys([apiJob(), apiJob()], 'stable')).toEqual([])
  })

  it('keeps a failed production API retirement pending for the next full retry', () => {
    const repo = repository()
    const target = repo.commit('cloudflare_workers/api/index.ts', 'api change')
    const attempt = evidence(target, 'capgo-1.1.0')
    const pending = beginDeployment(ready(repo.sha), attempt, ['api'], () => true)
    const failedCleanup = apiJob()
    failedCleanup.conclusion = 'failure'
    failedCleanup.steps[1].conclusion = 'failure'

    const next = completeDeployment(pending, attempt, completedDeploymentKeys([failedCleanup], 'stable'))

    expect(next.entries.api.success?.sha).toBe(repo.sha)
    expect(next.entries.api.pending).toEqual(attempt)
    expect(resolveDeployScopeFromGit(target, next, repo.git).scope.api).toBe(true)
    expect(completedDeploymentKeys([apiJob()], 'stable')).toEqual(['api'])
  })

  it('requires production API retirement while accepting the alpha publish without that production-only step', () => {
    const publishOnly = job('deploy_api', ['Deploy CF Worker API'])

    expect(completedDeploymentKeys([publishOnly], 'stable')).toEqual([])
    expect(completedDeploymentKeys([publishOnly], 'alpha')).toEqual(['api'])
  })

  it('requires stable schema reconciliation, deployment and subscription refresh together; alpha only its applicable operations', () => {
    expect(completedDeploymentKeys([stableSupabaseJob()], 'stable')).toEqual([])
    const refresh = refreshJob()
    refresh.steps[0].conclusion = 'failure'
    expect(completedDeploymentKeys([stableSupabaseJob(), refresh], 'stable')).toEqual([])
    expect(completedDeploymentKeys([supabaseJob(), refreshJob()], 'stable')).toEqual([])
    expect(completedDeploymentKeys([stableSupabaseJob(), refreshJob()], 'stable')).toEqual(['supabase'])
    expect(completedDeploymentKeys([supabaseJob()], 'alpha')).toEqual(['supabase'])
    expect(completedDeploymentKeys([supabaseJob()], 'stable')).toEqual([])
  })

  // The fixtures above once named a job that the workflow did not have, so production never
  // recorded Supabase as deployed and redeployed it on every release. Pin them to the workflow.
  it('names only jobs and steps that exist in build_and_deploy.yml', () => {
    const source = readFileSync(new URL('../.github/workflows/build_and_deploy.yml', import.meta.url), 'utf8')
    interface Step { name?: string, parallel?: Step[] }
    const jobs = (parse(source) as { jobs: Record<string, { name?: string, steps?: Step[] }> }).jobs
    const stepsByJob = new Map<string, Set<string>>()
    for (const [key, definition] of Object.entries(jobs)) {
      const names = new Set((definition.steps ?? []).flatMap(step => [step, ...(step.parallel ?? [])]).map(step => step.name).filter((name): name is string => !!name))
      stepsByJob.set(definition.name ?? key, names)
    }
    for (const fixture of [apiJob(), stableSupabaseJob(), refreshJob()]) {
      expect(stepsByJob.has(fixture.name), `${fixture.name} job`).toBe(true)
      for (const step of fixture.steps)
        expect(stepsByJob.get(fixture.name)?.has(step.name), `${fixture.name} / ${step.name}`).toBe(true)
    }
  })

  it('uses nine real stable plugin destinations and one independent alpha destination', () => {
    expect(pluginMatrix('stable').include.map(item => item.region)).toEqual(['eu', 'as', 'us', 'sa', 'oc', 'af', 'me', 'hk', 'jp'])
    expect(pluginMatrix('alpha').include).toEqual([{ region: 'alpha', region_label: 'alpha', cf_target: 'plugin' }])
    expect(pluginMatrix('stable').include.find(item => item.region === 'us')?.cf_target).toBe('plugin_na')
  })

  it('captures partial matrix successes and models alpha as its single actual destination', () => {
    const jobs = [job('Deploy CF Worker Plugin (Europe (EU))', ['Deploy CF Worker Plugin']), job('Deploy CF Worker Plugin (Asia (AS))', [])]
    expect(completedDeploymentKeys(jobs, 'stable')).toEqual(['plugins_eu'])
    expect(completedDeploymentKeys(jobs, 'alpha')).toEqual([])
    expect(completedDeploymentKeys([job('Deploy CF Worker Plugin (alpha)', ['Deploy CF Worker Plugin'])], 'alpha')).toEqual(['plugins_alpha'])
  })

  it('accepts an old-created ALL rerun resolving a newer source target without ordering by run ID', () => {
    const current = evidence('2'.repeat(40), 'capgo-1.2.0', '10', 4)
    const state = ready('1'.repeat(40))
    state.entries.api.success = evidence('1'.repeat(40), 'capgo-1.1.0', '99')
    const pending = beginDeployment(state, current, ['api'], () => true)
    expect(completeDeployment(pending, current, ['api']).entries.api.success).toEqual(current)
  })

  it('keeps refresh failures pending for subsequent tags, and rejects mismatched retargeted evidence', () => {
    const old = '1'.repeat(40)
    const current = evidence('2'.repeat(40), 'capgo-1.2.0', '9', 2)
    const pending = beginDeployment(ready(old), current, ['supabase', 'api'], () => true)
    const next = completeDeployment(pending, current, completedDeploymentKeys([supabaseJob(), apiJob()], 'stable'))
    expect(next.entries.supabase.success?.sha).toBe(old)
    expect(next.entries.supabase.pending).toEqual(current)
    expect(next.entries.api.success).toEqual(current)
    expect(next.entries.files).toEqual(pending.entries.files)
    expect(() => completeDeployment(pending, { ...current, sha: old }, ['api'])).toThrow('immutable pending')
    expect(() => completeDeployment(pending, { ...current, attempt: 1 }, ['api'])).toThrow('immutable pending')
    expect(() => beginDeployment(next, evidence(old), ['api'], () => false)).toThrow('regressing')
    expect(() => beginDeployment(next, { ...current, attempt: 1 }, ['api'], () => true)).toThrow('regressing')
  })
})

describe('durable manifest CAS in a local bare remote', () => {
  it('preserves source/index and untouched entries, rejects concurrent initialization and stale writers', () => {
    const repo = repository()
    const initial = readState('stable', repo.git)
    const pending = beginDeployment(ready(repo.sha), evidence(repo.sha), ['api'], () => true)
    const oid = writeState(initial, pending, repo.git)
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.sha)
    expect(repo.git(['status', '--short'])).toBe('')
    expect(() => writeState(initial, pending, repo.git)).toThrow()
    const snapshot = readState('stable', repo.git)
    expect(snapshot.oid).toBe(oid)
    const next = completeDeployment(snapshot.state, evidence(repo.sha), ['api'])
    writeState(snapshot, next, repo.git)
    expect(() => writeState(snapshot, pending, repo.git)).toThrow()
    expect(readState('stable', repo.git).state.entries.files).toEqual(pending.entries.files)
    expect(readState('alpha', repo.git).oid).toBeNull()
  })

  it('runs begin/completion with the resolved retry identity instead of the original event SHA', () => {
    const repo = repository()
    writeState(readState('stable', repo.git), ready(repo.sha), repo.git)
    const target = repo.commit('cloudflare_workers/api/index.ts', 'api change')
    repo.git(['tag', 'capgo-1.1.0'])
    const bin = join(repo.root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s' '${JSON.stringify({ total_count: 1, jobs: [apiJob()] })}'\n`, { mode: 0o755 })
    const helper = fileURLToPath(new URL('../scripts/deploy-state.ts', import.meta.url))
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'example/project',
      GITHUB_RUN_ID: '10',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: repo.sha,
      DEPLOY_TAG: 'capgo-1.1.0',
      DEPLOY_SHA: target,
    }
    const output = execFileSync('bun', [helper, 'begin'], { cwd: repo.source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const oid = output.split('\n').find(line => line.startsWith('state_oid='))?.slice('state_oid='.length)
    expect(oid).toMatch(/^[a-f0-9]{40}$/)
    execFileSync('bun', [helper, 'complete'], { cwd: repo.source, env: { ...env, DEPLOY_STATE_OID: oid }, stdio: ['ignore', 'pipe', 'pipe'] })
    const state = readState('stable', repo.git).state
    expect(state.entries.api.success).toEqual(evidence(target, 'capgo-1.1.0', '10', 2))
    expect(state.entries.api.pending).toBeNull()
    expect(state.entries.files.success?.sha).toBe(repo.sha)
  })

  it('rejects a lease race between the preflight read and the actual push', () => {
    const repo = repository()
    writeState(readState('stable', repo.git), ready(repo.sha), repo.git)
    const snapshot = readState('stable', repo.git)
    let raced = false
    const racingGit: Git = (args, input) => {
      if (args[0] === 'push' && !raced) {
        raced = true
        writeState(snapshot, beginDeployment(snapshot.state, evidence(repo.sha), ['files'], () => true), repo.git)
      }
      return repo.git(args, input)
    }
    expect(() => writeState(snapshot, beginDeployment(snapshot.state, evidence(repo.sha), ['api'], () => true), racingGit)).toThrow()
    expect(readState('stable', repo.git).state.entries.files.pending).not.toBeNull()
    expect(readState('stable', repo.git).state.entries.api.pending).toBeNull()
  })

  it('rejects damaged manifests, wrong environments and moved evidence tags', () => {
    expect(() => stateSchema.parse({ version: 2, environment: 'stable', entries: {} })).toThrow()
    expect(() => stateSchema.parse({ version: 1, environment: 'alpha', entries: ready('1'.repeat(40)).entries })).toThrow()
    const repo = repository()
    expect(() => validateStateTargets(ready('a'.repeat(40)), repo.git)).toThrow('tag/SHA mismatch')
    const blob = repo.git(['hash-object', '-w', '--stdin'], 'not JSON')
    const tree = repo.git(['mktree'], `100644 blob ${blob}\tmanifest.json\n`)
    const commit = repo.git(['commit-tree', tree, '-m', 'test: malformed state'])
    repo.git(['push', 'origin', `${commit}:refs/heads/deployment-state-stable`])
    expect(() => readState('stable', repo.git)).toThrow()
  })
})

const historyRun = (id: number, sha: string, tag = 'capgo-1.0.0', attempt = 1) => ({ id, run_attempt: attempt, head_branch: tag, head_sha: sha, status: 'completed', event: 'push' })
describe('bounded validated historical bootstrap', () => {
  it('recovers successful components in failed runs but leaves reconciliation unresolved', () => {
    const repo = repository()
    const pinned = 'bun scripts/resolve-deploy-tag.ts --resolve "' + '$' + '{{ github.ref_name }}"'
    const sha = repo.commit('.github/workflows/build_and_deploy.yml', pinned)
    repo.git(['tag', 'capgo-1.1.0'])
    const api: ActionsApi = path => path.includes('/jobs?')
      ? { total_count: 1, jobs: [apiJob()] }
      : { total_count: 1, workflow_runs: [historyRun(10, sha, 'capgo-1.1.0')] }
    const state = bootstrapState('stable', 'example/project', '11', api, repo.git)
    expect(state.entries.api.success).toEqual(evidence(sha, 'capgo-1.1.0'))
    expect(state.entries.api.pending).not.toBeNull()
    expect(state.entries.plugins_eu).toBeUndefined()
    expect(resolveDeployScopeFromGit(sha, state, repo.git).scope.plugins).toBe(true)
  })

  it('does not trust a mismatching historical tag/SHA or an unvalidated workflow', () => {
    const repo = repository()
    const different = repo.commit('README.md', 'later source')
    const api: ActionsApi = (path) => {
      expect(path).not.toContain('/jobs?')
      return { total_count: 1, workflow_runs: [historyRun(10, different)] }
    }
    expect(bootstrapState('stable', 'example/project', '11', api, repo.git).entries).toEqual({})
  })

  it('never substitutes event head_sha for a historical rerun resolved target; missing history stays unknown', () => {
    const repo = repository()
    const api: ActionsApi = () => ({ total_count: 1, workflow_runs: [historyRun(10, repo.sha, 'capgo-1.0.0', 2)] })
    expect(bootstrapState('stable', 'example/project', '11', api, repo.git).entries).toEqual({})
    expect(bootstrapState('alpha', 'example/project', '11', () => ({ total_count: 0, workflow_runs: [] }), repo.git).entries).toEqual({})
    expect(() => bootstrapState('stable', 'example/project', '11', () => ({ workflow_runs: 'damaged' }), repo.git)).toThrow()
  })

  it('bounds run pagination and validates attempt-specific job pagination, rejecting gaps and oversized history', () => {
    const paths: string[] = []
    const api: ActionsApi = (path) => {
      paths.push(path)
      return { total_count: 500, workflow_runs: Array.from({ length: 10 }, (_, i) => historyRun(i + 1, '1'.repeat(40), 'capgo-1.0.0', 2)) }
    }
    bootstrapState('stable', 'example/project', '11', api)
    expect(paths).toHaveLength(2)
    expect(paths[1]).toContain('per_page=10&page=2')
    const jobPaths: string[] = []
    const paged: ActionsApi = (path) => {
      jobPaths.push(path)
      return { total_count: 2, jobs: [job('other', [])] }
    }
    expect(readAttemptJobs(paged, 'example/project', '1', 3)).toHaveLength(2)
    expect(jobPaths[1]).toContain('/attempts/3/jobs?per_page=100&page=2')
    expect(() => readAttemptJobs(() => ({ total_count: 1, jobs: [] }), 'example/project', '1', 1)).toThrow('incomplete')
    expect(() => readAttemptJobs(() => ({ total_count: 900, jobs: [job('other', [])] }), 'example/project', '1', 1)).toThrow('300-job bound')
    expect(readFileSync(new URL('../scripts/publish-release.ts', import.meta.url), 'utf8')).toContain('--atomic')
  })
})
