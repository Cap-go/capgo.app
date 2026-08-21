# Native-Aware Release Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Capgo releases force a major version before native-incompatible changes, publish OTA for every tagged release, and synchronize the tagged version into every iOS and Android native build request.

**Architecture:** Keep the existing test-gated bump workflow and tag-triggered deployment workflow. Add one pre-tag decision step that interprets `build needed`, reuses the existing GitHub Release as a narrow incomplete-release guard, and feeds the final severity into `standard-version`; then make tagged OTA upload unconditional and add platform version-sync flags to every native request path.

**Tech Stack:** GitHub Actions YAML, Bash, Capgo CLI via `bunx @capgo/cli@latest`, Vitest workflow contract tests.

---

## Task 1: Add failing release-workflow contract tests

**Files:**
- Create: `tests/capgo-release-workflow.unit.test.ts`
- Read: `.github/workflows/bump_version.yml`
- Read: `.github/workflows/build_and_deploy.yml`
- Read: `.github/workflows/build_mobile_ios.yml`
- Read: `.github/workflows/build_mobile_android.yml`

- [ ] **Step 1: Create workflow readers and step extraction helper**

```ts
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
```

- [ ] **Step 2: Add the pre-tag decision contract**

```ts
describe('native-aware Capgo release workflow', () => {
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
```

- [ ] **Step 3: Add OTA ordering and native flag contracts**

```ts
  it.concurrent('uploads OTA before creating the GitHub Release', async () => {
    const workflow = await readWorkflow(workflowPaths.deploy)
    const ota = getStep(workflow, 'Deploy OTA bundle to Capgo')

    expect(ota).toContain('bunx @capgo/cli@latest bundle upload')
    expect(ota).not.toContain('native_build_needed')
    expect(workflow.indexOf('Deploy OTA bundle to Capgo')).toBeLessThan(
      workflow.indexOf('Create GitHub release'),
    )
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
```

- [ ] **Step 4: Run the focused test and verify it fails for the missing workflow behavior**

Run: `bunx vitest run tests/capgo-release-workflow.unit.test.ts`

Expected from the pre-implementation baseline, before Tasks 2 and 3: FAIL because `Resolve Capgo native release bump` does not exist, OTA still has a compatibility condition, and automatic/manual Android requests lack `--sync-android-version`.

- [ ] **Step 5: Commit the failing contract test**

```bash
git add tests/capgo-release-workflow.unit.test.ts
git commit -m "test(ci): define native-aware release contracts"
```

## Task 2: Implement the pre-tag release decision

**Files:**
- Modify: `.github/workflows/bump_version.yml`
- Test: `tests/capgo-release-workflow.unit.test.ts`

- [ ] **Step 1: Add the decision step after dependency installation**

```yaml
      - name: Resolve Capgo native release bump
        id: capgo_version
        if: ${{ needs.changes.outputs.run_capgo == 'true' }}
        env:
          CAPGO_TOKEN: ${{ secrets.CAPGO_TOKEN }}
          GH_TOKEN: ${{ github.token }}
          DEFAULT_RELEASE_AS: ${{ needs.changes.outputs.capgo_release_as }}
        run: |
          if [ "$GITHUB_REF" = "refs/heads/main" ]; then
            channel="production"
          else
            channel="dev"
          fi

          set +e
          bunx @capgo/cli@latest build needed --channel "$channel"
          exit_code=$?
          set -e

          if [ "$exit_code" -eq 0 ]; then
            echo "release_as=$DEFAULT_RELEASE_AS" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          if [ "$exit_code" -ne 1 ]; then
            echo "::error::build needed failed with exit code $exit_code"
            exit "$exit_code"
          fi

          if [ "$GITHUB_REF" = "refs/heads/main" ]; then
            previous_tag="$(git describe --tags --match 'capgo-*' --exclude '*-alpha.*' --abbrev=0 2>/dev/null || true)"
          else
            previous_tag="$(git describe --tags --match 'capgo-*-alpha.*' --abbrev=0 2>/dev/null || true)"
          fi
          if [ -n "$previous_tag" ]; then
            if ! release_is_draft="$(gh release view "$previous_tag" --repo "$GITHUB_REPOSITORY" --json isDraft --jq '.isDraft')"; then
              echo "::error::Could not confirm a completed GitHub Release for $previous_tag. No new version will be created."
              exit 1
            fi
            if [ "$release_is_draft" != "false" ]; then
              echo "::error::$previous_tag is still a draft GitHub Release. No new version will be created."
              exit 1
            fi
          fi

          echo "release_as=major" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 2: Feed the resolved severity into `standard-version`**

Replace:

```yaml
          CAPGO_RELEASE_AS: ${{ needs.changes.outputs.capgo_release_as }}
```

With:

```yaml
          CAPGO_RELEASE_AS: ${{ steps.capgo_version.outputs.release_as }}
```

- [ ] **Step 3: Run the focused test**

Run: `bunx vitest run tests/capgo-release-workflow.unit.test.ts`

Expected: The pre-tag contract passes; OTA and Android sync assertions remain failing until Task 3.

- [ ] **Step 4: Commit the pre-tag implementation**

```bash
git add .github/workflows/bump_version.yml tests/capgo-release-workflow.unit.test.ts
git commit -m "feat(ci): make Capgo version bumps native-aware"
```

## Task 3: Publish OTA for native releases and synchronize platform versions

**Files:**
- Modify: `.github/workflows/build_and_deploy.yml`
- Modify: `.github/workflows/build_mobile_android.yml`
- Verify: `.github/workflows/build_mobile_ios.yml`
- Test: `tests/capgo-release-workflow.unit.test.ts`

- [ ] **Step 1: Make tagged OTA upload unconditional**

Remove this line from the `Deploy OTA bundle to Capgo` step:

```yaml
        if: steps.release_check.outputs.native_build_needed == 'false'
```

Keep the existing upload command and GitHub Release step order unchanged.

- [ ] **Step 2: Synchronize versions in automatic native requests**

Use:

```yaml
run: bunx @capgo/cli@latest build request --platform ios --path . --sync-ios-version --ai-analytics
```

and:

```yaml
run: bunx @capgo/cli@latest build request --platform android --path . --sync-android-version --ai-analytics
```

- [ ] **Step 3: Synchronize the manually dispatched Android build**

In `.github/workflows/build_mobile_android.yml`, use:

```yaml
run: bunx @capgo/cli@latest build request --platform android --path . --sync-android-version --ai-analytics
```

The existing manual iOS request already contains `--sync-ios-version` and remains unchanged.

- [ ] **Step 4: Run the focused test and verify all contracts pass**

Run: `bunx vitest run tests/capgo-release-workflow.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the tagged-deployment implementation**

```bash
git add .github/workflows/build_and_deploy.yml .github/workflows/build_mobile_android.yml tests/capgo-release-workflow.unit.test.ts
git commit -m "feat(ci): publish OTA alongside native releases"
```

## Task 4: Verify the complete change and prepare the pull request

**Files:**
- Verify: `.github/workflows/bump_version.yml`
- Verify: `.github/workflows/build_and_deploy.yml`
- Verify: `.github/workflows/build_mobile_ios.yml`
- Verify: `.github/workflows/build_mobile_android.yml`
- Verify: `tests/capgo-release-workflow.unit.test.ts`
- Verify: `docs/superpowers/specs/2026-08-19-native-aware-release-flow-design.md`
- Verify: `docs/superpowers/plans/2026-08-19-native-aware-release-flow.md`

- [ ] **Step 1: Run workflow contract and release-scope tests**

Run: `bunx vitest run tests/capgo-release-workflow.unit.test.ts tests/release-scope.test.ts`

Expected: PASS.

- [ ] **Step 2: Run unit tests**

Run: `bun test:unit`

Expected: PASS.

- [ ] **Step 3: Run repository linting**

Run: `bun lint`

Expected: PASS with no new lint errors.

- [ ] **Step 4: Check formatting and the final diff**

Run: `git diff --check origin/main...HEAD`

Expected: no output.

Run: `git status --short`

Expected: only the pre-existing uncommitted `codedb.snapshot` change remains.

- [ ] **Step 5: Push and create the pull request**

```bash
git push -u origin wolny/native-aware-release-flow
gh pr create --repo Cap-go/capgo.app --base main --head wolny/native-aware-release-flow --title "feat(ci): make releases native-aware" --body $'## Summary (AI generated)\n\n- force major Capgo versions for native-incompatible releases\n- upload OTA before publishing the GitHub Release\n- synchronize visible iOS and Android versions for native builds\n\n## Motivation (AI generated)\n\nPrevent native-incompatible changes from being released indefinitely as native-only updates.\n\n## Business Impact (AI generated)\n\nKeep existing users on compatible OTA major lines while native store releases move users onto the next line.\n\n## Test Plan (AI generated)\n\n- bunx vitest run tests/capgo-release-workflow.unit.test.ts tests/release-scope.test.ts\n- bun test:unit\n- bun lint'
```

- [ ] **Step 6: Run the `pr-ready` workflow until stable-green**

Follow `/Users/michaltremblay/.agents/skills/pr-ready/SKILL.md`, address actionable review and CI failures, and finish only when the PR remains green across two consecutive polling rounds.
