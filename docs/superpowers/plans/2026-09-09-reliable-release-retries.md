# Reliable Release Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rapid-merge release generation race-safe while ensuring release-generation re-runs are rejected and deployment retries stay pinned to their original immutable tag.

**Architecture:** `bump_version.yml` calculates pending work from component-specific tags, cancels an older first-attempt push run when a newer source push arrives, rejects every re-run before tag generation, and publishes generated release refs with a compare-and-swap-style atomic push. `build_and_deploy.yml` resolves the tag that triggered the workflow, never retargets a retry, rejects stale retries before production mutation, and serializes deployments by environment. Production schema/types generation moves behind successful replica reconciliation and Supabase migration deployment, then publishes through a compare-and-swap retry loop on `main`.

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
- Create `scripts/publish-schema-types.ts`: publish one prepared schema/types commit only while `main` still equals the SHA used to generate it.
- Create `tests/publish-schema-types.test.ts`: prove schema publication succeeds only against the expected remote `main` and classifies branch movement as retryable.

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

- [x] **Step 5: Commit cumulative scope**

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

- [x] **Step 6: Commit atomic publication**

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

- [x] **Step 1: Write failing deploy-target and workflow tests**

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

- [x] **Step 2: Run the tests and verify they fail**

Run:

```bash
bunx vitest run tests/resolve-deploy-tag.test.ts tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

Expected: failures for the missing resolver and stale `github.ref` workflow behavior.

- [x] **Step 3: Implement the deploy-tag resolver**

Read tags in Git's creation order, using version order only as a tie-breaker. This is required because the repository contains an older `capgo-13.0.0` tag while the active release line is currently `capgo-12.x`:

```ts
run([
  'tag',
  '--list',
  'capgo-[0-9]*',
  '--sort=-version:refname',
  '--sort=-creatordate',
])
```

Filter stable tags by excluding `-alpha.` and alpha tags by requiring it. Resolve the chosen tag with `rev-list -n 1 <tag>`. The CLI prints GitHub outputs:

```text
deploy_tag=<tag>
deploy_sha=<sha>
is_alpha=<true|false>
```

- [x] **Step 4: Route the existing deployment workflow through the resolved tag**

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

- [x] **Step 5: Run the focused deployment tests**

Run:

```bash
bunx vitest run tests/resolve-deploy-tag.test.ts tests/deploy-scope.test.ts tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

Expected: all focused deployment tests pass.

- [x] **Step 6: Commit latest-tag deployment retries**

```bash
git add scripts/resolve-deploy-tag.ts tests/resolve-deploy-tag.test.ts .github/workflows/build_and_deploy.yml tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
git commit -m "fix(ci): rerun deployments from latest tag"
```

### Task 4: Full verification and PR handoff

**Files:**
- Verify all files above
- Update plan checkboxes as work completes

- [x] **Step 1: Run formatting and lint**

Run:

```bash
bun lint
```

Expected: exit code 0.

- [x] **Step 2: Run type checking**

Run:

```bash
bun typecheck
```

Expected: exit code 0.

- [x] **Step 3: Run the complete focused release suite**

Run:

```bash
bunx vitest run tests/release-scope.test.ts tests/publish-release.test.ts tests/resolve-deploy-tag.test.ts tests/deploy-scope.test.ts tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

Expected: exit code 0 with all tests passing.

- [x] **Step 4: Inspect the final diff and repository status**

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

## Approved revision: pinned retries and post-deploy schema sync

Tasks 1–3 above describe the first implementation already present on this PR branch. The following tasks replace Task 3's “newest tag” retry behavior with the user-approved immutable-tag design and relocate schema/type synchronization. Task 4 is repeated only after these revisions are complete.

### Task 5: Cancel superseded source pushes and reject version re-runs

**Files:**
- Modify: `tests/capgo-release-workflow.unit.test.ts`
- Modify: `.github/workflows/bump_version.yml`

- [x] **Step 1: Add failing workflow contract tests**

Require workflow-level concurrency that gives first-attempt, non-bot source pushes one shared branch group and gives bot commits or re-runs a unique group. Require `cancel-in-progress: true` so a new source push cancels older version work, without allowing an auto-generated commit or a manual re-run to cancel legitimate work.

Require explicit `github.run_attempt` guards in both `changes` and `bump-version`. The guard must exit non-zero with an actionable message, so “Re-run all jobs” and a direct re-run of the tag-generating job both fail before release mutation.

- [x] **Step 2: Run the focused workflow test and verify failure**

```bash
bunx vitest run tests/capgo-release-workflow.unit.test.ts
```

- [x] **Step 3: Implement concurrency and fail-fast guards**

Add a conditional concurrency group keyed by branch only for a first-attempt source push. Keep `chore(release):` and `chore(auto-sync):` runs, plus every `run_attempt > 1`, isolated with `github.run_id` and `github.run_attempt`.

Add this semantic guard before any meaningful work in both relevant jobs:

```bash
if [ "$GITHUB_RUN_ATTEMPT" != "1" ]; then
  echo "::error::Version-generation workflows cannot be re-run. Push a new commit so release scope is recalculated from current main."
  exit 1
fi
```

- [x] **Step 4: Re-run the focused workflow test**

Expected: the concurrency and re-run contracts pass without weakening the complete reusable test job.

### Task 6: Resolve and validate the triggering deployment tag

**Files:**
- Modify: `tests/resolve-deploy-tag.test.ts`
- Modify: `scripts/resolve-deploy-tag.ts`

- [x] **Step 1: Add failing exact-tag and freshness tests**

Add public APIs with this shape:

```ts
export function resolveDeployTag(tag: string, run?: GitRunner): DeployTag
export function assertCurrentDeployTag(tag: string, run?: GitRunner): DeployTag
```

Test that exact resolution never selects another tag; malformed tags and missing refs fail; stable and alpha freshness are evaluated independently; and a requested tag older than the newest tag for its environment throws a stale-deployment error.

- [x] **Step 2: Run the resolver tests and verify failure**

```bash
bunx vitest run tests/resolve-deploy-tag.test.ts
```

- [x] **Step 3: Implement exact resolution and freshness assertion**

Keep the creation-order-aware latest-tag resolver because it is needed only for the stale check. Add CLI modes:

```bash
bun scripts/resolve-deploy-tag.ts --resolve "$GITHUB_REF_NAME"
bun scripts/resolve-deploy-tag.ts --assert-current "$DEPLOY_TAG"
```

`--resolve` prints the exact event tag and SHA. `--assert-current` succeeds only when that same tag remains the newest stable/alpha tag and must never print or select a replacement deploy target.

- [x] **Step 4: Re-run the resolver tests**

Expected: exact resolution and same-environment freshness cases pass.

### Task 7: Pin deployment retries and expose migration scope

**Files:**
- Modify: `tests/deploy-scope.test.ts`
- Modify: `scripts/deploy-scope.ts`
- Modify: `tests/capgo-release-workflow.unit.test.ts`
- Modify: `tests/read-replica-release-workflow.unit.test.ts`
- Modify: `.github/workflows/build_and_deploy.yml`

- [x] **Step 1: Add failing deployment workflow contracts**

Require `changes` to resolve `${{ github.ref_name }}` exactly and reject a stale queued deployment at startup. For every production-mutating job, require a retry-only freshness check:

```yaml
if: ${{ github.run_attempt > 1 }}
run: bun scripts/resolve-deploy-tag.ts --assert-current "${{ needs.changes.outputs.deploy_tag }}"
```

This allows an initial deployment that already started to finish even if a newer tag appears, while an old failed run cannot mutate production after a newer tag exists. Keep every checkout, release, environment choice, and native build pinned to `needs.changes.outputs.deploy_sha` / `deploy_tag`.

Add `has_migration_changes` to `deploy-scope.ts` output for files under `supabase/migrations/`.

- [x] **Step 2: Run focused tests and verify failure**

```bash
bunx vitest run tests/deploy-scope.test.ts tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

- [x] **Step 3: Update deployment scope and workflow**

Resolve the triggering tag once in `changes`, immediately assert that it is current, and publish `has_migration_changes`. Add retry-only stale-tag guards before mutation in replica reconciliation, Supabase deployment, web/API/file/translation/plugin deployment, and native build-request jobs. Fetch tags in each guarded job so freshness is authoritative for that retry.

Keep environment concurrency non-cancelling. A newer deployment queues behind a running one; a queued older run that starts after a newer tag exists fails in `changes` before mutation.

- [x] **Step 4: Re-run focused deployment tests**

Expected: all deployment and replica contracts pass.

### Task 8: Compare-and-swap schema/types publication

**Files:**
- Create: `tests/publish-schema-types.test.ts`
- Create: `scripts/publish-schema-types.ts`

- [x] **Step 1: Write failing publisher tests**

Define:

```ts
export interface PublishSchemaTypesOptions {
  branch: string
  expectedBranchSha: string
  remote: string
}

export function publishSchemaTypes(
  options: PublishSchemaTypesOptions,
  run?: GitRunner,
): 'published' | 'retry'
```

Test that unchanged remote `main` uses a normal atomic `HEAD:refs/heads/main` push, branch movement before the push returns `retry` without pushing, a rejected push followed by branch movement returns `retry`, and a rejected push with unchanged remote state is a genuine error.

- [x] **Step 2: Run the test and verify failure**

```bash
bunx vitest run tests/publish-schema-types.test.ts
```

- [x] **Step 3: Implement the publisher**

Validate branch/SHA inputs, read remote `main` with `git ls-remote --heads`, and push only the prepared commit. Do not use `git pull`, force push, merge, or rebase. The CLI prints `published` or `retry` for the workflow loop.

- [x] **Step 4: Re-run the publisher tests**

Expected: all compare-and-swap cases pass.

### Task 9: Move schema/types generation after database deployment

**Files:**
- Modify: `tests/capgo-release-workflow.unit.test.ts`
- Modify: `tests/read-replica-release-workflow.unit.test.ts`
- Modify: `.github/workflows/bump_version.yml`
- Modify: `.github/workflows/build_and_deploy.yml`

- [x] **Step 1: Add failing workflow contracts**

Require `sync_schema_types` to be absent from `bump_version.yml` and present in `build_and_deploy.yml`. It must run only for stable releases with migration changes, after both `read_replica_schema` and `supabase_deploy` succeed.

Require a bounded retry loop that:

1. fetches current `main` and tags;
2. rejects/defer-successfully if the original deploy tag is no longer current;
3. defer-successfully if `main` contains migrations absent from the deployed tag;
4. checks out the fetched `main` SHA and regenerates the production schema and types;
5. defer-successfully if regenerated types do not typecheck against current source;
6. commits only generated files;
7. calls `publish-schema-types.ts` with that exact base SHA;
8. retries from a fresh `main` snapshot if compare-and-swap loses a race.

Require auto-sync commits to be ignored as component changes while allowing the
auto-sync-triggered version workflow to release any earlier real source changes
that remain pending. This is the handoff when the schema commit wins the branch
race while a newer source workflow is still testing.

- [x] **Step 2: Run workflow tests and verify failure**

```bash
bunx vitest run tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

- [x] **Step 3: Relocate and harden synchronization**

Remove the old pre-deploy job. Add the post-deploy job with explicit `contents: write`, production Supabase credentials, a small bounded retry count, exact-tag freshness checks, migration-diff deferral, typecheck deferral, and compare-and-swap publication.

The schema job must be non-blocking only for deliberate deferrals caused by newer work or incompatible latest source. Genuine generation, authentication, or push failures still fail visibly. Auto-sync commits use an isolated version-workflow concurrency group, contribute no release scope themselves, and take over cumulative pending work only when another source run was superseded.

- [x] **Step 4: Re-run focused tests**

Expected: schema synchronization is structurally downstream from both database targets and no release-generation workflow can publish schema output.

### Task 10: Revised verification and same-PR handoff

- [x] **Step 1: Run format/lint and typecheck**

```bash
bun lint
bun typecheck
```

- [x] **Step 2: Run the complete focused release suite**

```bash
bunx vitest run tests/release-scope.test.ts tests/publish-release.test.ts tests/resolve-deploy-tag.test.ts tests/deploy-scope.test.ts tests/publish-schema-types.test.ts tests/capgo-release-workflow.unit.test.ts tests/read-replica-release-workflow.unit.test.ts
```

- [ ] **Step 3: Inspect and push the existing PR branch**

```bash
git diff --check
git status --short
git diff origin/main...HEAD --stat
git push origin wolny/reliable-cicd-retries
```

- [ ] **Step 4: Re-run `pr-ready` until stable-green**

Keep this work in the existing PR. Inspect checks, reviews, unresolved conversations, mergeability, and base/head SHAs. Resolve actionable failures, then record two all-green observations at least five minutes apart with no relevant state change.
