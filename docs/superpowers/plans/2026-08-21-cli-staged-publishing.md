# CLI Staged Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct `@capgo/cli` npm publishing with the staged publishing and approval-dispatch flow documented by `Cap-go/automations`.

**Architecture:** The public tag workflow will authenticate to npm with the rotating organization `NPM_TOKEN` and stage either the `latest` or `next` release from the `cli` directory. A downstream job dispatches `npm-stage-approve` to the private automations repository and creates the GitHub release, allowing a failed dispatch to be retried without restaging; approval itself remains asynchronous and is not polled.

**Tech Stack:** GitHub Actions YAML, npm CLI, GitHub CLI, Bun, Vitest

---

## Task 1: Lock the staged-publishing contract in a workflow test

**Files:**
- Modify: `tests/release-scope.test.ts`
- Test: `tests/release-scope.test.ts`

- [ ] **Step 1: Add the failing workflow contract test**

Add this test inside the existing `describe('release scope matching', ...)` block:

```ts
it.concurrent('stages CLI publishing through automations approval', () => {
  const workflow = readFileSync('.github/workflows/publish_cli.yml', 'utf8')
  const dollar = '$'
  const publishJob = '  publish_cli:\n'
  const approvalJob = '  approve_and_release:\n'
  const stableStep = '- name: Stage CLI on npm\n'
  const nextStep = '- name: Stage CLI on npm with next tag'
  const stableGuard = `if: ${dollar}{{ !contains(github.ref, '-alpha.') }}`
  const nextGuard = `if: ${dollar}{{ contains(github.ref, '-alpha.') }}`
  const stableCommand = 'run: npm stage publish --access public --tag latest'
  const nextCommand = 'run: npm stage publish --access public --tag next'
  const dispatchStep = '- name: Request npm stage approval'
  const dispatchCommand = 'repos/Cap-go/automations/dispatches'
  const release = '- name: Create GitHub release'
  const publishJobIndex = workflow.indexOf(publishJob)
  const approvalJobIndex = workflow.indexOf(approvalJob)
  const publishSection = workflow.slice(publishJobIndex, approvalJobIndex)
  const approvalSection = workflow.slice(approvalJobIndex)
  const stableStepIndex = publishSection.indexOf(stableStep)
  const nextStepIndex = publishSection.indexOf(nextStep)
  const dispatchIndex = approvalSection.indexOf(dispatchStep)
  const releaseIndex = approvalSection.indexOf(release)
  const stableSection = publishSection.slice(stableStepIndex, nextStepIndex)
  const nextSection = publishSection.slice(nextStepIndex)
  const dispatchSection = approvalSection.slice(dispatchIndex, releaseIndex)

  expect(publishJobIndex).toBeGreaterThan(-1)
  expect(approvalJobIndex).toBeGreaterThan(publishJobIndex)
  expect(publishSection).toContain('uses: actions/setup-node@v7')
  expect(publishSection).toContain('registry-url: https://registry.npmjs.org')
  expect(publishSection).toContain('permissions:\n      contents: read')
  expect(publishSection).not.toContain('id-token: write')
  expect(publishSection).toContain(`changelog: ${dollar}{{ steps.changelog.outputs.result }}`)
  expect(publishSection).toContain(`from_tag: ${dollar}{{ steps.changelog_base.outputs.from_tag }}`)
  expect(stableStepIndex).toBeGreaterThan(-1)
  expect(nextStepIndex).toBeGreaterThan(stableStepIndex)
  expect(stableSection).toContain(stableGuard)
  expect(stableSection).toContain(stableCommand)
  expect(stableSection).toContain('working-directory: cli')
  expect(stableSection).toContain(`NODE_AUTH_TOKEN: ${dollar}{{ secrets.NPM_TOKEN }}`)
  expect(nextSection).toContain(nextGuard)
  expect(nextSection).toContain(nextCommand)
  expect(nextSection).toContain('working-directory: cli')
  expect(nextSection).toContain(`NODE_AUTH_TOKEN: ${dollar}{{ secrets.NPM_TOKEN }}`)
  expect(workflow).not.toContain('NPM_CONFIG_TOKEN')
  expect(workflow).not.toContain('bun publish')
  expect(approvalSection).toContain('needs: publish_cli')
  expect(approvalSection).toContain('permissions:\n      contents: read')
  expect(approvalSection).toContain(`needs.publish_cli.outputs.changelog`)
  expect(approvalSection).toContain(`needs.publish_cli.outputs.from_tag`)
  expect(approvalSection).not.toContain('npm stage publish')
  expect(dispatchIndex).toBeGreaterThan(-1)
  expect(dispatchSection).toContain(`GH_TOKEN: ${dollar}{{ secrets.NPM_STAGE_DISPATCH_TOKEN }}`)
  expect(dispatchSection).toContain(`gh api --method POST ${dispatchCommand}`)
  expect(dispatchSection).toContain('-f event_type=npm-stage-approve')
  expect(dispatchSection).toContain(`-f "client_payload[repository]=${dollar}{GITHUB_REPOSITORY}"`)
  expect(dispatchSection).toContain(`-f "client_payload[run_id]=${dollar}{GITHUB_RUN_ID}"`)
  expect(dispatchSection).toContain('-f "client_payload[package]=@capgo/cli"')
  expect(releaseIndex).toBeGreaterThan(dispatchIndex)
})
```

- [ ] **Step 2: Run the focused test and confirm the old workflow fails the new contract**

Run:

```bash
bunx vitest run tests/release-scope.test.ts
```

Expected: FAIL in `stages CLI publishing through automations approval` because the workflow does not yet contain the separate `approve_and_release` job, registry setup, or `npm stage publish`.

- [ ] **Step 3: Commit the failing contract test**

```bash
git add tests/release-scope.test.ts
git commit -m "test(ci): cover staged CLI publishing"
```

## Task 2: Implement the automations staged-publishing flow

**Files:**
- Modify: `.github/workflows/publish_cli.yml`
- Test: `tests/release-scope.test.ts`

- [ ] **Step 1: Configure npm authentication through setup-node**

Keep `publish_cli` at read-only GitHub contents access, remove its unused OIDC
permission, and update the existing setup step to include the npm registry:

```yaml
permissions:
  contents: read
outputs:
  changelog: ${{ steps.changelog.outputs.result }}
  from_tag: ${{ steps.changelog_base.outputs.from_tag }}
steps:
  - name: Setup Node.js
    uses: actions/setup-node@v7
    with:
      node-version: 24.x
      registry-url: https://registry.npmjs.org
```

- [ ] **Step 2: Replace both direct publish steps with staged publishing**

Replace the stable and alpha `bun publish` steps with:

```yaml
- name: Stage CLI on npm
  if: ${{ !contains(github.ref, '-alpha.') }}
  working-directory: cli
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: npm stage publish --access public --tag latest
- name: Stage CLI on npm with next tag
  if: ${{ contains(github.ref, '-alpha.') }}
  working-directory: cli
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: npm stage publish --access public --tag next
```

- [ ] **Step 3: Make approval dispatch retryable without restaging**

Expose the changelog data from `publish_cli`:

```yaml
outputs:
  changelog: ${{ steps.changelog.outputs.result }}
  from_tag: ${{ steps.changelog_base.outputs.from_tag }}
```

Move approval dispatch and GitHub release creation into this downstream job:

```yaml
approve_and_release:
  runs-on: ubuntu-latest
  name: Approve staged CLI and create GitHub release
  timeout-minutes: 10
  needs: publish_cli
  permissions:
    contents: read
  steps:
    - name: Request npm stage approval
      env:
        GH_TOKEN: ${{ secrets.NPM_STAGE_DISPATCH_TOKEN }}
      run: |
        gh api --method POST repos/Cap-go/automations/dispatches \
          -f event_type=npm-stage-approve \
          -f "client_payload[repository]=${GITHUB_REPOSITORY}" \
          -f "client_payload[run_id]=${GITHUB_RUN_ID}" \
          -f "client_payload[package]=@capgo/cli"
    - name: Create GitHub release
      id: create_release
      uses: softprops/action-gh-release@v2
      with:
        body: |
          ## 🆕 Changelog

          ${{ needs.publish_cli.outputs.changelog || '_Changelog was not generated automatically for this release._' }}

          ---

          🔗 **Full Changelog**: https://github.com/${{ github.repository }}/compare/${{ needs.publish_cli.outputs.from_tag }}...${{ github.ref_name }}
        make_latest: false
        token: '${{ secrets.PERSONAL_ACCESS_TOKEN }}'
        prerelease: ${{ contains(github.ref, '-alpha.') }}
```

Do not add polling or `continue-on-error`: an unavailable dispatch credential must stop the release visibly. GitHub's failed-job rerun can retry `approve_and_release` without rerunning the successful `publish_cli` job or duplicating the npm stage.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
bunx vitest run tests/release-scope.test.ts
```

Expected: PASS for all tests in `tests/release-scope.test.ts`.

- [ ] **Step 5: Validate YAML parsing and formatting**

Run:

```bash
bunx eslint tests/release-scope.test.ts .github/workflows/publish_cli.yml
git diff --check
```

Expected: both commands exit with status 0 and produce no errors. The configured
ESLint YAML parser validates workflow syntax while enforcing repository format.

- [ ] **Step 6: Commit the workflow implementation**

```bash
git add .github/workflows/publish_cli.yml
git commit -m "fix(ci): stage CLI releases through npm approval"
```

## Task 3: Run final repository validation and publish the pull request

**Files:**
- Verify: `.github/workflows/publish_cli.yml`
- Verify: `tests/release-scope.test.ts`
- Verify: `docs/superpowers/specs/2026-08-21-cli-staged-publishing-design.md`
- Verify: `docs/superpowers/plans/2026-08-21-cli-staged-publishing.md`

- [ ] **Step 1: Run final local gates from the complete branch state**

Run:

```bash
bunx vitest run tests/release-scope.test.ts
bunx eslint tests/release-scope.test.ts .github/workflows/publish_cli.yml
git diff --check origin/main...HEAD
```

Expected: the focused tests pass, lint exits 0, and Git reports no whitespace errors.

- [ ] **Step 2: Confirm the branch contains only the intended committed files**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected: the committed branch diff contains only the workflow, its focused test, the design spec, and this plan. The pre-existing local `codedb.snapshot` modification remains unstaged and is excluded from the pull request.

- [ ] **Step 3: Push the branch and open a draft pull request**

```bash
git push -u origin wolny/fix-cli-staged-publish
gh pr create --draft --base main --head wolny/fix-cli-staged-publish \
  --title "fix(ci): stage CLI releases through npm approval" \
  --body-file /tmp/capgo-cli-staged-publish-pr.md
```

The pull request body must use these exact sections:

- `## Summary (AI generated)` for the staged `latest`/`next` flow and retryable approval dispatch;
- `## Motivation (AI generated)` for the direct-publish failure and staged approval contract;
- `## Business Impact (AI generated)` for release reliability and the external prerequisite that organization secret `NPM_STAGE_DISPATCH_TOKEN` be made available to public repository `Cap-go/capgo.app` before the next CLI tag; and
- `## Test Plan (AI generated)` for the local validation commands and results.

- [ ] **Step 4: Apply the repository's PR-ready gate**

Follow the `pr-ready` skill against the created pull request: make it ready for review, wait for all required checks, confirm mergeability and review state, and obtain two unchanged green observations at least five minutes apart before handoff.
