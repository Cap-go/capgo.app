import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, string>
}

interface WorkflowJob {
  if?: string
  needs?: string[] | string
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
}

interface WorkflowDefinition {
  concurrency?: {
    'cancel-in-progress'?: boolean
    group?: string
  }
  jobs?: Record<string, WorkflowJob>
}

const workflowPaths = {
  bump: new URL('../.github/workflows/bump_version.yml', import.meta.url),
  deploy: new URL('../.github/workflows/build_and_deploy.yml', import.meta.url),
  ios: new URL('../.github/workflows/build_mobile_ios.yml', import.meta.url),
  android: new URL('../.github/workflows/build_mobile_android.yml', import.meta.url),
}

async function readWorkflow(path: URL): Promise<string> {
  return readFile(path, 'utf8')
}

function parseWorkflow(source: string): WorkflowDefinition {
  return parse(source) as WorkflowDefinition
}

function getStep(workflow: string, name: string): string {
  const marker = `      - name: ${name}\n`
  const start = workflow.indexOf(marker)
  if (start === -1)
    throw new Error(`Workflow step not found: ${name}`)
  const next = workflow.indexOf('\n      - name:', start + marker.length)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

describe('native-aware Capgo release workflow', () => {
  it.concurrent('cancels superseded source pushes without letting re-runs or bot commits cancel release work', async () => {
    const workflowSource = await readWorkflow(workflowPaths.bump)
    const workflow = parseWorkflow(workflowSource)

    expect(workflow.concurrency?.['cancel-in-progress']).toBe(true)
    expect(workflow.concurrency?.group).toContain('github.run_attempt == 1')
    expect(workflow.concurrency?.group).toContain("!startsWith(github.event.head_commit.message, 'chore(release):')")
    expect(workflow.concurrency?.group).toContain("!startsWith(github.event.head_commit.message, 'chore(auto-sync):')")
    expect(workflow.concurrency?.group).toContain('github.ref')
    expect(workflow.concurrency?.group).toContain('github.run_id')
    expect(workflow.concurrency?.group).toContain('github.run_attempt')
    expect(workflow.jobs?.changes?.if).not.toContain("chore(auto-sync):")
    expect(workflow.jobs?.['bump-version']?.if).not.toContain("chore(auto-sync):")
  })

  it.concurrent('fails every version-generation re-run before it can create tags', async () => {
    const workflow = parseWorkflow(await readWorkflow(workflowPaths.bump))

    for (const jobName of ['changes', 'bump-version']) {
      const steps = workflow.jobs?.[jobName]?.steps ?? []
      const guard = steps.find(step => step.name === 'Reject version workflow re-run')

      expect(guard, `${jobName} must reject re-runs independently`).toBeDefined()
      expect(guard?.if).toBe('${{ github.run_attempt != 1 }}')
      expect(guard?.run).toContain('Version-generation workflows cannot be re-run')
      expect(guard?.run).toContain('exit 1')
      expect(steps.indexOf(guard!)).toBe(0)
    }
  })

  it.concurrent('pins every deployment execution and retry to the triggering immutable tag', async () => {
    const workflowSource = await readWorkflow(workflowPaths.deploy)
    const workflow = parseWorkflow(workflowSource)
    const jobs = workflow.jobs ?? {}
    const targetCheckout = jobs.changes?.steps?.find(step => step.name === 'Checkout deployment target')
    const deploymentJobs = [
      'supabase_deploy',
      'read_replica_schema',
      'deploy_webapp',
      'deploy_api',
      'deploy_translation_worker',
      'deploy_files',
      'deploy_plugin_regions',
      'deploy_native_ios',
      'deploy_native_android',
    ]
    const downstreamCheckoutSteps = deploymentJobs.flatMap(jobName => jobs[jobName]?.steps ?? [])
      .filter(step => step.uses?.startsWith('actions/checkout@'))
    const allCheckoutSteps = Object.values(jobs)
      .flatMap(job => job.steps ?? [])
      .filter(step => step.uses?.startsWith('actions/checkout@'))

    expect(workflowSource).toContain("group: ${{ github.workflow }}-${{ contains(github.ref_name, '-alpha.') && 'alpha' || 'production' }}")
    expect(workflowSource).toContain('cancel-in-progress: false')
    expect(workflowSource).toContain('deploy_tag: ${{ steps.target.outputs.deploy_tag }}')
    expect(workflowSource).toContain('deploy_sha: ${{ steps.target.outputs.deploy_sha }}')
    expect(workflowSource).toContain('is_alpha: ${{ steps.target.outputs.is_alpha }}')
    expect(workflowSource).toContain('requires_schema_types_sync: ${{ steps.scope.outputs.requires_schema_types_sync }}')
    expect(workflowSource).toContain('bun scripts/resolve-deploy-tag.ts --resolve "${{ github.ref_name }}"')
    expect(workflowSource).toContain('bun scripts/resolve-deploy-tag.ts --assert-current "${{ github.ref_name }}"')
    expect(workflowSource).not.toContain('resolve-deploy-tag.ts "$mode"')
    expect(workflowSource).toContain('bun scripts/deploy-scope.ts "${{ steps.target.outputs.deploy_tag }}"')
    expect(targetCheckout).toMatchObject({
      uses: 'actions/checkout@v6',
      with: { ref: '${{ steps.target.outputs.deploy_sha }}' },
    })
    expect(downstreamCheckoutSteps.length).toBeGreaterThan(0)
    for (const checkout of downstreamCheckoutSteps)
      expect(checkout.with?.ref).toBe('${{ needs.changes.outputs.deploy_sha }}')
    for (const jobName of deploymentJobs) {
      const steps = jobs[jobName]?.steps ?? []
      const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'))
      const retryGuard = steps.find(step => step.name === 'Reject stale deployment retry')

      expect(checkout?.with?.['fetch-depth'], `${jobName} must fetch tags for retry validation`).toBe(0)
      expect(retryGuard, `${jobName} must reject stale retries before mutation`).toBeDefined()
      expect(retryGuard?.if).toBe('${{ github.run_attempt > 1 }}')
      expect(retryGuard?.run).toContain('resolve-deploy-tag.ts --assert-current')
      expect(retryGuard?.run).toContain('needs.changes.outputs.deploy_tag')
    }
    for (const checkout of allCheckoutSteps)
      expect(checkout.uses).toBe('actions/checkout@v6')
    expect(workflowSource).toContain('tag_name: ${{ needs.changes.outputs.deploy_tag }}')
    expect(workflowSource).toContain("prerelease: ${{ needs.changes.outputs.is_alpha == 'true' }}")
    const supabaseDeployIndex = workflowSource.indexOf('  supabase_deploy:')
    expect(supabaseDeployIndex).toBeGreaterThan(-1)
    expect(workflowSource.slice(supabaseDeployIndex)).not.toContain('github.ref')
  })

  it.concurrent('keeps post-merge tests and publishes release refs atomically', async () => {
    const workflow = await readWorkflow(workflowPaths.bump)

    expect(workflow).toContain('test:\n    needs: changes')
    expect(workflow).toContain('uses: ./.github/workflows/tests.yml')
    expect(workflow).toContain('needs: [changes, test]')
    expect(workflow).toContain("needs.test.result == 'success'")
    expect(workflow).toContain('--latest-stable')
    expect(workflow).toContain('--latest-alpha')
    expect(workflow).toContain('release-base-sha')
    expect(workflow).toContain('release-tags-before')
    expect(workflow).toContain('scripts/publish-release.ts')
    expect(workflow).not.toContain('git pull')
  })

  it.concurrent('synchronizes production schema and types only after both database deployments', async () => {
    const [bumpSource, deploySource] = await Promise.all([
      readWorkflow(workflowPaths.bump),
      readWorkflow(workflowPaths.deploy),
    ])
    const deploy = parseWorkflow(deploySource)
    const syncJob = deploy.jobs?.sync_schema_types
    const syncStep = syncJob?.steps?.find(step => step.name === 'Sync generated schema and types')

    expect(bumpSource).not.toContain('sync_schema_types:')
    expect(bumpSource).not.toContain('has_migration_changes')
    expect(bumpSource).not.toContain('migration_scope')
    expect(syncJob?.needs).toEqual(['changes', 'read_replica_schema', 'supabase_deploy'])
    expect(syncJob?.if).toContain("needs.changes.outputs.is_alpha != 'true'")
    expect(syncJob?.if).toContain("needs.changes.outputs.requires_schema_types_sync == 'true'")
    expect(syncJob?.if).toContain("needs.read_replica_schema.result == 'success'")
    expect(syncJob?.if).toContain("needs.supabase_deploy.result == 'success'")
    expect(syncJob?.permissions?.contents).toBe('write')
    expect(syncStep?.run).toContain('for attempt in 1 2 3')
    expect(syncStep?.run).toContain('refs/remotes/schema-sync/main')
    expect(syncStep?.run).toContain('resolve-deploy-tag.ts --assert-current')
    expect(syncStep?.run).toContain('git diff --name-only "$DEPLOY_TAG" "$main_sha" -- supabase/migrations')
    expect(syncStep?.run).toContain('git checkout --detach "$main_sha"')
    expect(syncStep?.run).toContain('bun schemas')
    expect(syncStep?.run).toContain('BRANCH=main bun types')
    expect(syncStep?.run).toContain('bun typecheck')
    expect(syncStep?.run).toContain('scripts/publish-schema-types.ts main "$main_sha"')
    expect(syncStep?.run).not.toContain('git pull')
    expect(syncStep?.run).not.toMatch(/git (?:push )?--force/)
  })

  it.concurrent('decides the Capgo version after tests and before standard-version', async () => {
    const workflow = await readWorkflow(workflowPaths.bump)
    const decision = getStep(workflow, 'Resolve Capgo native release bump')

    expect(workflow).toContain('needs: [changes, test]')
    expect(workflow).toContain("needs.test.result == 'success'")
    expect(workflow.indexOf('Resolve Capgo native release bump')).toBeLessThan(
      workflow.indexOf('Create version bumps'),
    )
    expect(decision).toContain('refs/heads/main')
    expect(decision).toContain('channel="production"')
    expect(decision).toContain('channel="dev"')
    expect(decision).toContain('bunx @capgo/cli@latest build needed --channel "$channel"')
    expect(decision).toContain('release_as=$DEFAULT_RELEASE_AS')
    expect(decision).toContain('if [ "$exit_code" -ne 1 ]')
    expect(decision).toContain('exit "$exit_code"')
    const previousTagGuardIndex = decision.indexOf('if [ -n "$previous_tag" ]')
    const releaseAsMajorIndex = decision.indexOf('echo "release_as=major"')
    const releaseLineLookup = decision.slice(
      decision.lastIndexOf('if [ "$GITHUB_REF"', previousTagGuardIndex),
      previousTagGuardIndex,
    )
    const releaseLineElseIndex = releaseLineLookup.indexOf('else')
    const stableTagMatcherIndex = releaseLineLookup.indexOf("--match 'capgo-*' --exclude '*-alpha.*'")
    expect(stableTagMatcherIndex).toBeGreaterThan(-1)
    expect(stableTagMatcherIndex).toBeLessThan(releaseLineElseIndex)
    expect(releaseLineLookup.indexOf("--match 'capgo-*-alpha.*'")).toBeGreaterThan(releaseLineElseIndex)

    const guardedReleaseLookup = decision.slice(previousTagGuardIndex, releaseAsMajorIndex)
    expect(guardedReleaseLookup).toContain('gh release view "$previous_tag"')
    expect(guardedReleaseLookup).toContain("--json isDraft --jq '.isDraft'")
    expect(guardedReleaseLookup).toContain('if [ "$release_is_draft" != "false" ]')
    expect(decision.slice(0, previousTagGuardIndex)).not.toContain('gh release view "$previous_tag"')
    expect(decision.slice(releaseAsMajorIndex)).not.toContain('gh release view "$previous_tag"')
    expect(decision).toContain('Could not confirm a completed GitHub Release')
    expect(decision).toContain('release_as=major')
    expect(decision).toContain('exit 1')
    expect(workflow).toContain('CAPGO_RELEASE_AS: ${{ steps.capgo_version.outputs.release_as }}')
  })

  it.concurrent('uploads OTA before creating the GitHub Release', async () => {
    const workflow = await readWorkflow(workflowPaths.deploy)
    const ota = getStep(workflow, 'Deploy OTA bundle to Capgo')

    expect(ota).toContain('bunx @capgo/cli@latest bundle upload')
    expect(ota).not.toContain('native_build_needed')
    expect(workflow.indexOf('Deploy OTA bundle to Capgo')).toBeLessThan(
      workflow.indexOf('Create GitHub release'),
    )
    expect(workflow.match(/needs\.deploy_webapp\.outputs\.native_build_needed == 'true'/g)).toHaveLength(2)
  })

  it.concurrent('synchronizes visible versions in every native build request', async () => {
    const workflows = await Promise.all(Object.values(workflowPaths).map(readWorkflow))
    const requestLines = workflows.flatMap(workflow => workflow
      .split('\n')
      .filter(line => line.includes('build request --platform')))
    const iosRequests = requestLines.filter(line => line.includes('--platform ios'))
    const androidRequests = requestLines.filter(line => line.includes('--platform android'))

    expect(iosRequests.length).toBeGreaterThan(0)
    expect(androidRequests.length).toBeGreaterThan(0)
    for (const request of iosRequests)
      expect(request).toContain('--sync-ios-version')
    for (const request of androidRequests)
      expect(request).toContain('--sync-android-version')
  })
})
