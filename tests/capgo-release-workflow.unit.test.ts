import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflowPaths = {
  bump: new URL('../.github/workflows/bump_version.yml', import.meta.url),
  deploy: new URL('../.github/workflows/build_and_deploy.yml', import.meta.url),
  ios: new URL('../.github/workflows/build_mobile_ios.yml', import.meta.url),
  android: new URL('../.github/workflows/build_mobile_android.yml', import.meta.url),
}

async function readWorkflow(path: URL): Promise<string> {
  return readFile(path, 'utf8')
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
    const workflow = await readWorkflow(workflowPaths.deploy)
    const deploymentJobs = workflow.slice(workflow.indexOf('  supabase_deploy:'))
    const checkoutSteps = deploymentJobs.split('uses: actions/checkout@v6').slice(1)

    expect(workflow).toContain("group: ${{ github.workflow }}-${{ contains(github.ref_name, '-alpha.') && 'alpha' || 'production' }}")
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('deploy_tag: ${{ steps.target.outputs.deploy_tag }}')
    expect(workflow).toContain('deploy_sha: ${{ steps.target.outputs.deploy_sha }}')
    expect(workflow).toContain('is_alpha: ${{ steps.target.outputs.is_alpha }}')
    expect(workflow).toContain('bun scripts/resolve-deploy-tag.ts')
    expect(workflow).toContain('bun scripts/deploy-scope.ts "${{ steps.target.outputs.deploy_tag }}"')
    expect(checkoutSteps.length).toBeGreaterThan(0)
    for (const checkout of checkoutSteps)
      expect(checkout.slice(0, 180)).toContain('ref: ${{ needs.changes.outputs.deploy_tag }}')
    expect(workflow).toContain('tag_name: ${{ needs.changes.outputs.deploy_tag }}')
    expect(workflow).toContain("prerelease: ${{ needs.changes.outputs.is_alpha == 'true' }}")
    expect(deploymentJobs).not.toContain('github.ref')
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
