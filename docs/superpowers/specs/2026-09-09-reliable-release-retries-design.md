# Reliable Release Retries

## Goal

Make Capgo releases resilient to rapid merges without weakening validation. The
complete post-merge test suite remains mandatory. A newer real branch push
cancels an older, unfinished version workflow so that the newer workflow tests
and releases the cumulative state. Version-workflow re-runs are rejected.

A failed production deployment is recoverable with GitHub's native **Re-run
failed jobs** action. A deployment retry remains pinned to its original immutable
tag and is allowed only while that tag is still the newest tag for its stable or
alpha environment. An older deployment must never silently switch to or roll
back from another release.

This change updates the existing `bump_version.yml` and
`build_and_deploy.yml` workflows. It does not add another workflow.

## Observed failure modes

The current version workflow scopes a release from the individual push range
`github.event.before..github.sha`. When a release run fails and a later push only
touches another component, the later run does not see the earlier component's
still-untagged changes.

Each version run also generates release commits, tags, and Graphify artifacts in
an isolated checkout, then executes `git pull --rebase=false` immediately before
pushing. If `main` moved while tests or generation were running, Git attempts to
merge generated artifacts. Concurrent Graphify changes have already produced
merge conflicts and failed the release job.

Finally, generated schema and TypeScript files are currently synchronized from
production immediately after tag publication, in a different workflow from the
database deployment. The synchronization can therefore read the old production
schema before the migration is applied. It can also lose a non-fast-forward push
race when another pull request advances `main` while generation is running.

## Design

### 1. Preserve the post-merge quality gate

`bump_version.yml` continues invoking the complete reusable test workflow before
creating any release commit or tag. A test failure remains a real release
failure. This design changes only release-state calculation and publication; it
does not skip, soften, or ignore tests.

### 2. Calculate cumulative release scope per component

The release scope for each component is calculated from that component's latest
matching tag to the tested commit:

- Capgo: latest `capgo-*` tag to the tested commit
- CLI: latest `cli-*` tag to the tested commit
- Notifications: latest `notifications-*` tag to the tested commit

Stable and alpha tags remain separate. A stable release uses the latest stable
tag and excludes alpha tags; a development release uses the latest alpha tag.

This makes release scope state-based rather than event-based. If a Capgo release
run fails, every later run continues to see the untagged Capgo changes regardless
of which files caused the later push. Once a Capgo tag is successfully published,
the next Capgo range starts at that new tag and the changes are no longer pending.

If the selected component tag already contains the tested commit, that component
has no pending release. This makes historical workflow re-runs safe after a newer
tag has already covered their commits.

Release severity is still the highest Conventional Commit severity among the
matching, not-yet-tagged commits.

### 3. Cancel superseded version workflows

The version workflow uses branch-scoped concurrency with cancellation enabled
for normal pushes to `main` and `development`. When commit B is pushed while the
version workflow for commit A is unfinished, GitHub cancels A and B runs the
complete test suite against the cumulative A+B state.

Generated `chore(release):` and `chore(auto-sync):` pushes use an isolated
concurrency identity. They must not cancel the real version workflow that caused
them. Release commits retain their job-level skip guard. Auto-sync commits are
excluded from component release scope, but their workflow is allowed to examine
earlier pending commits. A manual re-run also uses an isolated identity so that
retrying historical work cannot cancel the current branch release.

If A's atomic publication has already completed before cancellation arrives, A
is a valid published release and is not undone. If cancellation wins before
publication, A has produced no remote release state and B's cumulative scope
includes A.

Every version workflow rejects `github.run_attempt > 1` before release
publication. Recovery from a failed version attempt requires a new branch push;
operators do not re-run tag creation against historical state.

### 4. Publish release refs atomically without merging

The version job records the tested branch SHA before generating files. It no
longer pulls or merges `main` into generated release output.

Before publication, the job checks the current remote branch SHA:

- If it still equals the tested SHA, the release commit and only the newly
  generated tags are pushed together with `git push --atomic`.
- If it changed, the job emits a clear superseded summary and exits successfully.
  The newer main push has its own fully tested version run, and cumulative scope
  ensures that run includes every still-untagged change.
- If the atomic push fails while the remote SHA is still unchanged, the failure
  is genuine (authentication, repository policy, network, or another unexpected
  condition) and the job fails normally.
- If the remote moves in the small interval between the preflight comparison and
  the push, a second comparison classifies the rejected atomic push as safely
  superseded.

Atomic publication guarantees that the branch update and all component tags are
accepted together or rejected together. It prevents orphaned tags, partial
multi-component releases, and generated-file merge conflicts.

The superseded path remains a final race guard in addition to concurrency. It
does not conceal test failures: it is reachable only after the complete
post-merge suite passed for that run.

### 5. Pin deployment retries to their original tag

`build_and_deploy.yml` keeps its existing `capgo-*` tag trigger. Each run
validates and resolves the exact tag from its original `github.ref_name`. GitHub
preserves the original `GITHUB_REF` and `GITHUB_SHA` on a re-run, so every job in
that run remains bound to the same immutable release.

At the start of an initial workflow attempt, the scope job fetches the current
tags and verifies that the run's original tag is still the newest tag for its
stable or alpha environment. Once that attempt begins mutating production, it
runs to completion even if a newer tag is published. This prevents a newer tag
from interrupting the older deployment after only some targets were updated;
the environment-wide deployment concurrency group keeps the newer deployment
queued until the older one finishes.

On a workflow re-run, every production-mutating job repeats the freshness check
before that job touches production. Therefore:

- If it is still newest, a failed job may be retried idempotently.
- If a newer matching tag exists, the historical job fails fast before touching
  production during that retry and directs the operator to retry the newer
  tag's deployment run.

The supported recovery action is **Re-run failed jobs**. GitHub re-runs failed
jobs and their dependent jobs while retaining the original event ref. The
freshness guard lives inside each mutating job rather than only in a previously
successful scope job, so a selective retry cannot bypass it.

Full workflow re-runs do not retarget to a newer tag. They remain pinned to the
original tag and are subject to the same freshness guard.

### 6. Serialize production deployment without cancellation

Deployment concurrency is grouped by environment rather than by original tag.
Production runs share one group and alpha runs share another. The workflow uses
`cancel-in-progress: false`, so a new tag never cancels a deployment that may
already be mutating production.

Queued runs remain pinned to their own tags. If a queued older run is no longer
current when one of its mutating jobs starts, it fails fast. Repeated deployment
of the same current tag must remain idempotent, which matches the retry
expectation for migrations, replica reconciliation, Cloudflare publication, and
OTA upload.

### 7. Synchronize production schema and types after database deployment

The schema/type synchronization moves from `bump_version.yml` into
`build_and_deploy.yml`. For a stable tag containing migrations, the order is:

1. reconcile the Google Cloud SQL subscriber schema;
2. apply Supabase migrations and deploy the allowlisted functions;
3. read the resulting production schema;
4. regenerate the schema dump and TypeScript types;
5. typecheck the regenerated files;
6. publish a `chore(auto-sync):` commit.

The synchronization checks out the latest `main`, records its SHA, generates
against production, and pushes only if `main` still has that SHA. If another
pull request advances `main`, it refreshes the checkout and retries generation
against the new source state. It never force-pushes or uses `git pull` over
generated files.

If the newer `main` contains a migration not present in the deployed tag, or if
the production-generated types do not compile against the newer source, the job
reports the synchronization as deferred and exits successfully. The deployment
for the later cumulative migration release performs the authoritative sync.
This permits a short, explicit interval where the checked-in production snapshot
lags the live database without making an already-successful database migration
look failed.

Before publishing the auto-sync commit, the job rechecks both the original
deployment tag's freshness and the expected `main` SHA. If either changed, it
retries or defers without overwriting newer work.

An auto-sync compare-and-swap can legitimately win while a newer source push's
version workflow is still testing. In that case the source workflow becomes
superseded because `main` moved. The auto-sync push provides the handoff: its
isolated version workflow ignores the generated auto-sync commit itself, but
still sees, tests, and releases any earlier source changes that remain pending.
If the newer source workflow already published, the auto-sync workflow finds no
pending component work and becomes a no-op. This closes the race without making
generated schema files create a release by themselves.

## Error handling and observability

Both workflows write the tested or deployed SHA, selected component baselines,
original release tag, current environment tag, cancellation/supersession reason,
and schema-sync publication outcome to the GitHub job summary. Missing or
malformed release tags fail before any production mutation.

Version publication distinguishes a normal main-advanced race from all other Git
push errors. Deployment retains failures from real migration, replica, build, or
provider errors so operators can fix the cause and use **Re-run failed jobs**.

## Verification

Automated tests will cover:

- cumulative component scope after an earlier release run failed;
- independent baselines for Capgo, CLI, and Notifications;
- already-covered historical commits becoming no-ops;
- stable tags excluding alpha tags and alpha releases selecting alpha tags;
- version workflow retaining the complete reusable test gate;
- removal of `git pull` from release publication;
- atomic branch-and-tag publication and safe supersession checks;
- newer real pushes cancelling unfinished older version workflows;
- generated release/auto-sync pushes and manual re-runs not cancelling current
  version work;
- auto-sync commits not creating releases by themselves while still handing off
  earlier pending source changes;
- version workflow re-runs failing before publication;
- deployment retries retaining the original tag and allowing the current tag;
- stale deployment retries failing inside every production-mutating job;
- every deployment checkout and release action using the original validated tag;
- production deployment concurrency not cancelling in-progress runs;
- schema/type generation running after replica reconciliation and Supabase
  migration deployment;
- schema/type publication retrying a moving `main` without force or pull;
- schema/type synchronization deferring when newer migrations make the live
  production schema an unsafe source for the newer code.

Local completion gates are repository lint, typecheck, and the focused release
workflow/unit tests. The PR then follows the repository's stable-green review
process with two unchanged green observations at least five minutes apart.

## Explicit non-goals

- Do not remove or reduce the complete post-merge test suite.
- Do not add a separate retry or deployment workflow.
- Do not make failed tests appear successful.
- Do not mutate or force-update an existing release tag.
- Do not use force pushes for release publication.
- Do not change database migration or read-replica reconciliation behavior.
- Do not make a historical deployment run deploy a newer tag.
- Do not permit version/tag creation from a manually re-run version workflow.
