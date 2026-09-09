# Reliable Release Retries

## Goal

Make Capgo releases resilient to rapid merges without weakening validation. The
complete post-merge test suite remains mandatory. A failed production deployment
must be recoverable with GitHub's native **Re-run all jobs** action, and that retry
must deploy the newest stable Capgo tag rather than the stale tag that originally
started the run.

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

Finally, production deployment runs are permanently bound to the tag from their
original push event. GitHub re-runs the same workflow execution context, so a
retry continues deploying old code even when a newer release tag contains the
fix for the original failure.

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

### 3. Publish release refs atomically without merging

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

The superseded path does not conceal test failures: it is reachable only after
the complete post-merge suite passed for that run.

### 4. Resolve the newest deployment tag on every full re-run

`build_and_deploy.yml` keeps its existing `capgo-*` tag trigger. Its initial
scope job fetches all tags and resolves the newest tag for the run's environment:

- A stable production run resolves the newest stable `capgo-*` tag.
- An alpha run resolves the newest `capgo-*-alpha.*` tag.

The resolved tag and SHA become workflow outputs. Deploy scope calculation,
every checkout, environment selection, changelog generation, and GitHub Release
creation use that resolved tag instead of `github.ref_name`.

Consequently, selecting GitHub's **Re-run all jobs** on any deployment run created
after this change executes the scope job again and targets the newest available
Capgo release. **Re-run failed jobs** is not the recovery contract because GitHub
does not rerun successful prerequisite jobs and cannot activate jobs that were
previously skipped under an older scope.

Existing historical runs cannot acquire a newer workflow definition. One new
Capgo-tagged deployment after this PR merges establishes the retry behavior for
future runs.

### 5. Serialize production deployment without cancellation

Deployment concurrency is grouped by environment rather than by original tag.
Production runs share one group and alpha runs share another. The workflow uses
`cancel-in-progress: false`, so a new tag never cancels a deployment that may
already be mutating production.

Queued older runs resolve the newest tag when they execute. Repeated deployment
of the same newest tag must remain idempotent, which matches the existing retry
expectation for migrations, replica reconciliation, Cloudflare publication, and
OTA upload.

## Error handling and observability

Both workflows write the tested or deployed SHA, selected component baselines,
resolved release tag, and supersession reason to the GitHub job summary. Missing
or malformed release tags fail before any production mutation.

Version publication distinguishes a normal main-advanced race from all other Git
push errors. Deployment retains failures from real migration, replica, build, or
provider errors so operators can fix the cause and use **Re-run all jobs**.

## Verification

Automated tests will cover:

- cumulative component scope after an earlier release run failed;
- independent baselines for Capgo, CLI, and Notifications;
- already-covered historical commits becoming no-ops;
- stable tags excluding alpha tags and alpha releases selecting alpha tags;
- version workflow retaining the complete reusable test gate;
- removal of `git pull` from release publication;
- atomic branch-and-tag publication and safe supersession checks;
- deployment workflow resolving the newest tag on each full execution;
- every deployment checkout and release action using the resolved tag;
- production deployment concurrency not cancelling in-progress runs.

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
