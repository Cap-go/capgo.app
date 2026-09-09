# Reliable Release Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rapid-merge release generation race-safe and make native deployment “Re-run all jobs” target the newest Capgo tag without removing the complete post-merge test gate or adding another workflow.

**Architecture:** `bump_version.yml` will calculate pending work from component-specific tags and publish generated release refs with a compare-and-swap-style atomic push. `build_and_deploy.yml` will resolve the newest stable or alpha Capgo tag on every full execution and route every checkout and release action through that immutable target.

**Tech Stack:** GitHub Actions YAML, Bun/TypeScript, Git refs, Vitest.

---

## File map

- Modify `scripts/release-scope.ts`: resolve cumulative scope from the latest component tag.
- Modify `tests/release-scope.test.ts`: prove failed releases remain pending and stable/alpha baselines are independent.
- Create `scripts/publish-release.ts`: atomically publish a release commit and only its new tags, classifying main movement as supersession.
- Create `tests/publish-release.test.ts`: prove atomic arguments, preflight supersession, race supersession, and genuine failure handling.
- Modify `.github/workflows/bump_version.yml`: retain full tests, use cumulative scope, record the tested SHA/tag snapshot, and call atomic publication without `git pull`.
- Create `scripts/resolve-deploy-tag.ts`: resolve the newest stable or alpha Capgo tag and its commit.
- Create `tests/resolve-deploy-tag.test.ts`: prove stable and alpha selection and malformed/missing tag rejection.
- Modify `.github/workflows/build_and_deploy.yml`: serialize by environment and use the resolved tag for scope, checkouts, environment, and GitHub Release creation.
- Modify `tests/capgo-release-workflow.unit.test.ts`: lock the version and deployment workflow contracts.
- Modify `tests/read-replica-release-workflow.unit.test.ts`: preserve the replica gate while switching its environment condition to the resolved target.

### Task 1: Cumulative component release scope

**Files:**
- Modify: `tests/release-scope.test.ts`
- Modify: `scripts/release-scope.ts`

- [x] **Step 1: Replace the push-only regression with failing cumulative-scope tests**

Add tests that call a new `resolvePendingReleaseScope()` API. The key case must model a Capgo change followed by a CLI-only triggering commit and expect the Capgo change to remain releasable:

```ts
expect(resolvePendingReleaseScope('capgo', 'head-cli-only', false, run)).toEqual({
  base: 'capgo-12.0.0',
  shouldRelease: true,
  releaseAs: 'minor',
})
```

Add separate expectations that stable resolution invokes:

```ts
['describe', '--tags', '--match', 'capgo-[0-9]*', '--exclude', 'capgo-*-alpha.*', '--abbrev=0', 'head']
```

and alpha resolution invokes:

```ts
['describe', '--tags', '--match', 'capgo-*-alpha.*', '--abbrev=0', 'head']
```

- [x] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bunx vitest run tests/release-scope.test.ts
```

Expected: failure because `resolvePendingReleaseScope` is not exported.

- [x] **Step 3: Implement latest-tag scope resolution**

Add the following public result and resolver shape to `scripts/release-scope.ts`:

```ts
export interface PendingReleaseScope {
  base: string | null
  releaseAs: ReleaseAs
  shouldRelease: boolean
}

export function resolvePendingReleaseScope(
  component: Component,
  after: string,
  includePrereleaseTags: boolean,
  run: GitRunner = runGit,
): PendingReleaseScope
```

Resolve the closest reachable tag using `${component}-[0-9]*` with alpha tags excluded for stable branches and `${component}-*-alpha.*` for development. Evaluate every commit in `base..after`; when no tag exists, evaluate the full reachable history. Keep `resolveReleaseScope()` for explicit ranges and existing callers.

Update the CLI to accept:

```bash
bun scripts/release-scope.ts <component> --latest-stable <after>
bun scripts/release-scope.ts <component> --latest-alpha <after>
```

and emit `base=`, `should_release=`, and `release_as=`.

- [x] **Step 4: Run the focused tests**

Run:

```bash
bunx vitest run tests/release-scope.test.ts
```

Expected: all release-scope tests pass.

- [ ] **Step 5: Commit cumulative scope**

```bash
git add scripts/release-scope.ts tests/release-scope.test.ts
git commit -m "fix(ci): preserve unreleased component scope"
```

### Task 2: Atomic release publication

**Files:**
- Create: `scripts/publish-release.ts`
- Create: `tests/publish-release.test.ts`
- Modify: `.github/workflows/bump_version.yml`
- Modify: `tests/capgo-release-workflow.unit.test.ts`

- [x] **Step 1: Write failing publisher and workflow contract tests**

Define tests around this public API:

```ts
export interface PublishReleaseOptions {
  branch: string
  expectedBranchSha: string
  knownTags: readonly string[]
  remote: string
}

export function publishReleaseAtomically(
  options: PublishReleaseOptions,
  run?: GitRunner,
): 'published' | 'superseded'
```

Test these exact behaviors:

- remote SHA differs before push: return `superseded` and never call `git push`;
- unchanged remote: call `git push --atomic` with `HEAD:refs/heads/<branch>` and only tags absent from `knownTags`;
- push rejects and the remote then changed: return `superseded`;
- push rejects and the remote remains unchanged: rethrow the push error.

Extend the workflow contract test to require the complete reusable `test` job, `needs: [changes, test]`, a known-tags snapshot, `publish-release.ts`, and no `git pull` in the publication step.

- [x] **Step 2: Run the tests and verify they fail**

Run:

```bash
bunx vitest run tests/publish-release.test.ts tests/capgo-release-workflow.unit.test.ts
```

Expected: failures for the missing publisher and old pull-based workflow.

- [x] **Step 3: Implement the atomic publisher**

Implement `scripts/publish-release.ts` with `execFileSync('git', args)` and strict ref validation. Read the remote branch with:

```ts
run(['ls-remote', '--heads', remote, `refs/heads/${branch}`])
```

Build the publication arguments as:

```ts
[
  'push',
  '--atomic',
  remote,
  `HEAD:refs/heads/${branch}`,
  ...newTags.map(tag => `refs/tags/${tag}:refs/tags/${tag}`),
]
```

On the CLI path, read known tags from the supplied snapshot file, print `published` or `superseded` to stdout, and write a human-readable reason to stderr.

- [x] **Step 4: Wire atomic publication into the existing bump workflow**

Change all three scope steps to use `--latest-stable` on `main` and `--latest-alpha` on `development`. Preserve the reusable full `test` job unchanged.

In `bump-version`, record the tested SHA and existing tags before generating anything:

```bash
git rev-parse HEAD > "$RUNNER_TEMP/release-base-sha"
git tag --list | sort > "$RUNNER_TEMP/release-tags-before"
```

Replace the pull/push block with:

```bash
status="$(bun scripts/publish-release.ts \
  "$CURRENT_BRANCH" \
  "$(cat "$RUNNER_TEMP/release-base-sha")" \
  "$RUNNER_TEMP/release-tags-before")"
echo "published=$([[ "$status" = published ]] && echo true || echo false)" >> "$GITHUB_OUTPUT"
```

Pass the credentialed remote through `RELEASE_REMOTE_URL`. Give the step `id: publish` and expose `published` as a job output. Gate `sync_schema_types` on `needs.bump-version.outputs.published == 'true'` so superseded runs cannot create an auto-sync race.

- [x] **Step 5: Run the focused tests**

Run:

```bash
bunx vitest run tests/publish-release.test.ts tests/release-scope.test.ts tests/capgo-release-workflow.unit.test.ts
```

Expected: all focused version-workflow tests pass.

- [ ] **Step 6: Commit atomic publication**

```bash
git add scripts/publish-release.ts tests/publish-release.test.ts .github/workflows/bump_version.yml tests/capgo-release-workflow.unit.test.ts
git commit -m "fix(ci): publish release refs atomically"
```

### Task 3: Native re-runs deploy the newest Capgo tag

**Files:**
- Create: `scripts/resolve-deploy-tag.ts`
- Create: `tests/resolve-deploy-tag.test.ts`
- Modify: `.github/workflows/build_and_deploy.yml`
- Modify: `tests/capgo-release-workflow.unit.test.ts`
- Modify: `tests/read-replica-release-workflow.unit.test.ts`

- [ ] **Step 1: Write failing deploy-target and workflow tests**

Define and test:

```ts
export interface DeployTag {
  isAlpha: boolean
  sha: string
  tag: string
}

export function resolveLatestDeployTag(
  includePrereleaseTags: boolean,
  run?: GitRunner,
): DeployTag
```

The stable test supplies Git-sorted tags containing stable and alpha versions and expects the newest stable tag. The alpha test expects the newest alpha tag. Missing or malformed tags must throw before returning a target.

Extend workflow tests to require environment-level non-cancelling concurrency, target outputs from `changes`, all deployment checkouts using `needs.changes.outputs.deploy_tag`, deploy scope using that tag, and GitHub Release `tag_name` using that tag.

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
bunx vitest run tests/resolve-deploy-tag.test.ts tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

Expected: failures for the missing resolver and stale `github.ref` workflow behavior.

- [ ] **Step 3: Implement the deploy-tag resolver**

Read tags in Git's version order:

```ts
run(['tag', '--list', 'capgo-[0-9]*', '--sort=-version:refname'])
```

Filter stable tags by excluding `-alpha.` and alpha tags by requiring it. Resolve the chosen tag with `rev-list -n 1 <tag>`. The CLI prints GitHub outputs:

```text
deploy_tag=<tag>
deploy_sha=<sha>
is_alpha=<true|false>
```

- [ ] **Step 4: Route the existing deployment workflow through the resolved tag**

Set concurrency to a stable/alpha environment group with `cancel-in-progress: false`. In `changes`, resolve the newest tag, expose its outputs, check out that tag, and run `deploy-scope.ts` against it.

For every downstream `actions/checkout`, add:

```yaml
with:
  ref: ${{ needs.changes.outputs.deploy_tag }}
```

Replace environment decisions based on `github.ref` with `needs.changes.outputs.is_alpha`. Set the GitHub Release action fields to:

```yaml
tag_name: ${{ needs.changes.outputs.deploy_tag }}
prerelease: ${{ needs.changes.outputs.is_alpha == 'true' }}
```

Keep the replica reconciliation dependency graph and all deploy failure behavior intact.

- [ ] **Step 5: Run the focused deployment tests**

Run:

```bash
bunx vitest run tests/resolve-deploy-tag.test.ts tests/deploy-scope.test.ts tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

Expected: all focused deployment tests pass.

- [ ] **Step 6: Commit latest-tag deployment retries**

```bash
git add scripts/resolve-deploy-tag.ts tests/resolve-deploy-tag.test.ts .github/workflows/build_and_deploy.yml tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
git commit -m "fix(ci): rerun deployments from latest tag"
```

### Task 4: Full verification and PR handoff

**Files:**
- Verify all files above
- Update plan checkboxes as work completes

- [ ] **Step 1: Run formatting and lint**

Run:

```bash
bun lint
```

Expected: exit code 0.

- [ ] **Step 2: Run type checking**

Run:

```bash
bun typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run the complete focused release suite**

Run:

```bash
bunx vitest run tests/release-scope.test.ts tests/publish-release.test.ts tests/resolve-deploy-tag.test.ts tests/deploy-scope.test.ts tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

Expected: exit code 0 with all tests passing.

- [ ] **Step 4: Inspect the final diff and repository status**

Run:

```bash
git diff --check
git status --short
git diff origin/main...HEAD --stat
```

Expected: no whitespace errors; only the planned CI/CD, tests, spec, and plan files are present.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin wolny/reliable-cicd-retries
gh pr create --base main --head wolny/reliable-cicd-retries --title "fix(ci): make release retries converge on latest state" --body-file <prepared-body>
```

The PR body must summarize the observed races, state that full post-merge tests remain mandatory, describe **Re-run all jobs** semantics, list local verification, and avoid private data.

- [ ] **Step 6: Establish stable-green**

Use the `pr-ready` workflow to inspect checks, reviews, unresolved conversations, mergeability, and base/head SHAs. Record observation A only when all required gates are green. Recheck fresh state at least 300 seconds later and record observation B only if no relevant state changed.
