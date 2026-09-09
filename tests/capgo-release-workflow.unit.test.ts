import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  name?: string
  uses?: string
  with?: Record<string, string>
}

interface WorkflowJob {
  steps?: WorkflowStep[]
}

interface WorkflowDefinition {
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
  it.concurrent('reruns deployment against the newest immutable environment tag', async () => {
    const workflowSource = await readWorkflow(workflowPaths.deploy)
    const workflow = parseWorkflow(workflowSource)
    const jobs = workflow.jobs ?? {}
    const targetCheckout = jobs.changes?.steps?.find(step => step.name === 'Checkout deployment target')
    const downstreamCheckoutSteps = Object.entries(jobs)
      .filter(([jobName]) => jobName !== 'changes')
      .flatMap(([, job]) => job.steps ?? [])
      .filter(step => step.uses?.startsWith('actions/checkout@'))
    const allCheckoutSteps = Object.values(jobs)
      .flatMap(job => job.steps ?? [])
      .filter(step => step.uses?.startsWith('actions/checkout@'))

    expect(workflowSource).toContain("group: ${{ github.workflow }}-${{ contains(github.ref_name, '-alpha.') && 'alpha' || 'production' }}")
    expect(workflowSource).toContain('cancel-in-progress: false')
    expect(workflowSource).toContain('deploy_tag: ${{ steps.target.outputs.deploy_tag }}')
    expect(workflowSource).toContain('deploy_sha: ${{ steps.target.outputs.deploy_sha }}')
    expect(workflowSource).toContain('is_alpha: ${{ steps.target.outputs.is_alpha }}')
    expect(workflowSource).toContain('bun scripts/resolve-deploy-tag.ts')
    expect(workflowSource).toContain('bun scripts/deploy-scope.ts "${{ steps.target.outputs.deploy_tag }}"')
    expect(targetCheckout).toMatchObject({
      uses: 'actions/checkout@v6',
      with: { ref: '${{ steps.target.outputs.deploy_sha }}' },
    })
    expect(downstreamCheckoutSteps.length).toBeGreaterThan(0)
    for (const checkout of downstreamCheckoutSteps)
      expect(checkout.with?.ref).toBe('${{ needs.changes.outputs.deploy_sha }}')
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
    expect(workflow).toContain("needs.bump-version.outputs.published == 'true'")
    expect(workflow).not.toContain('git pull')
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
