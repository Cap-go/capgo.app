# CLI Staged Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct `@capgo/cli` npm publishing with the staged publishing and approval-dispatch flow documented by `Cap-go/automations`.

**Architecture:** The public tag workflow will authenticate to npm with the rotating organization `NPM_TOKEN`, stage either the `latest` or `next` release from the `cli` directory, and then dispatch `npm-stage-approve` to the private automations repository. Approval remains asynchronous, so the existing GitHub release step follows the accepted dispatch without polling npm.

**Tech Stack:** GitHub Actions YAML, npm CLI, GitHub CLI, Bun, Vitest

---

### Task 1: Lock the staged-publishing contract in a workflow test

**Files:**
- Modify: `tests/release-scope.test.ts`
- Test: `tests/release-scope.test.ts`

- [ ] **Step 1: Add the failing workflow contract test**

Add this test inside the existing `describe('release scope matching', ...)` block:

```ts
it.concurrent('stages CLI publishing through automations approval', () => {
  const workflow = readFileSync('.github/workflows/publish_cli.yml', 'utf8')
  const stageStable = 'run: npm stage publish --access public --tag latest'
  const stageNext = 'run: npm stage publish --access public --tag next'
  const dispatch = 'repos/Cap-go/automations/dispatches'
  const release = '- name: Create GitHub release'

  expect(workflow).toContain('registry-url: https://registry.npmjs.org')
  expect(workflow).toContain(stageStable)
  expect(workflow).toContain(stageNext)
  expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}')
  expect(workflow).not.toContain('NPM_CONFIG_TOKEN')
  expect(workflow).not.toContain('bun publish')
  expect(workflow).toContain('GH_TOKEN: ${{ secrets.NPM_STAGE_DISPATCH_TOKEN }}')
  expect(workflow).toContain(dispatch)
  expect(workflow).toContain('-f event_type=npm-stage-approve')
  expect(workflow).toContain('-f "client_payload[repository]=${GITHUB_REPOSITORY}"')
  expect(workflow).toContain('-f "client_payload[run_id]=${GITHUB_RUN_ID}"')
  expect(workflow).toContain('-f "client_payload[package]=@capgo/cli"')
  expect(workflow.indexOf(dispatch)).toBeLessThan(workflow.indexOf(release))
})
```

- [ ] **Step 2: Run the focused test and confirm the old workflow fails the new contract**

Run:

```bash
bunx vitest run tests/release-scope.test.ts
```

Expected: FAIL in `stages CLI publishing through automations approval` because the workflow does not yet contain `registry-url: https://registry.npmjs.org` or `npm stage publish`.

- [ ] **Step 3: Commit the failing contract test**

```bash
git add tests/release-scope.test.ts
git commit -m "test(ci): cover staged CLI publishing"
```

### Task 2: Implement the automations staged-publishing flow

**Files:**
- Modify: `.github/workflows/publish_cli.yml`
- Test: `tests/release-scope.test.ts`

- [ ] **Step 1: Configure npm authentication through setup-node**

Update the existing setup step to include the npm registry:

```yaml
- name: Setup Node.js
  uses: actions/setup-node@v6
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

- [ ] **Step 3: Dispatch the stage approval before GitHub release creation**

Insert this step immediately after the two mutually exclusive staging steps and before `Create GitHub release`:

```yaml
- name: Request npm stage approval
  env:
    GH_TOKEN: ${{ secrets.NPM_STAGE_DISPATCH_TOKEN }}
  run: |
    gh api --method POST repos/Cap-go/automations/dispatches \
      -f event_type=npm-stage-approve \
      -f "client_payload[repository]=${GITHUB_REPOSITORY}" \
      -f "client_payload[run_id]=${GITHUB_RUN_ID}" \
      -f "client_payload[package]=@capgo/cli"
```

Do not add polling or `continue-on-error`: an unavailable dispatch credential must stop the release visibly, while a successful dispatch hands asynchronous approval to `Cap-go/automations`.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
bunx vitest run tests/release-scope.test.ts
```

Expected: PASS for all tests in `tests/release-scope.test.ts`.

- [ ] **Step 5: Validate YAML parsing and formatting**

Run:

```bash
bun -e "import { parse } from 'yaml'; parse(await Bun.file('.github/workflows/publish_cli.yml').text())"
bunx eslint tests/release-scope.test.ts .github/workflows/publish_cli.yml
git diff --check
```

Expected: all commands exit with status 0 and produce no errors.

- [ ] **Step 6: Commit the workflow implementation**

```bash
git add .github/workflows/publish_cli.yml
git commit -m "fix(ci): stage CLI releases through npm approval"
```

### Task 3: Run final repository validation and publish the pull request

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
bun -e "import { parse } from 'yaml'; parse(await Bun.file('.github/workflows/publish_cli.yml').text())"
git diff --check origin/main...HEAD
```

Expected: the focused tests pass, lint and YAML parsing exit 0, and Git reports no whitespace errors.

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

The pull request body must summarize the staged `latest`/`next` flow, the approval dispatch, the local validation, and the external prerequisite that organization secret `NPM_STAGE_DISPATCH_TOKEN` be made available to public repository `Cap-go/capgo.app` before the next CLI tag release.

- [ ] **Step 4: Apply the repository's PR-ready gate**

Follow the `pr-ready` skill against the created pull request: make it ready for review, wait for all required checks, confirm mergeability and review state, and obtain two unchanged green observations at least five minutes apart before handoff.
