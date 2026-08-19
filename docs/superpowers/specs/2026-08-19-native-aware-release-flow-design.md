# Native-Aware Release Flow Design

## Goal

Keep OTA and native releases on a coherent semantic-version line without replacing the existing Capgo release workflows. When the local project is no longer native-compatible with the bundle linked to the target channel, the pre-tag workflow must create the next major Capgo version. The tag workflow must then publish the OTA and request both native builds with the tagged application version.

## Current behavior

`bump_version.yml` runs release-scope tests before `standard-version` creates and pushes component tags. Its Capgo release severity is derived only from conventional commits.

`build_and_deploy.yml` runs `bunx @capgo/cli@latest build needed` after a `capgo-*` tag is pushed. A compatible change uploads an OTA. An incompatible change skips the OTA and requests iOS and Android builds. The automatic native requests do not currently use the version-sync flags.

This means a native-required release can leave the production channel linked to an older bundle, causing later releases to keep reporting that a native build is needed.

## Release design

### Pre-tag decision

The existing `bump-version` job remains gated by the reusable test workflow. After dependency installation and before `standard-version`, it runs:

```text
main        -> build needed --channel production
development -> build needed --channel dev
```

The command's existing exit-code contract controls the result:

- `0`: native build not required; retain the conventional Capgo release severity.
- `1`: native build required; override the Capgo release severity to `major`.
- Any other code: fail the bump job before creating a version commit or tag.

The CLI invocation remains `bunx @capgo/cli@latest`.

### Preventing repeated major bumps

When `build needed` returns `1`, the bump job finds the latest reachable `capgo-*` tag. If that tag exists but has no published, non-draft GitHub Release, the bump job exits with an error before invoking `standard-version`.

The check does not retry or dispatch any workflow. It only prevents a second version bump. The existing incomplete tag remains available for a manual rerun of its deployment.

The guard is deliberately narrow: it runs only when a native build is currently required. OTA-compatible releases are not blocked by an unrelated missing GitHub Release.

No new state is introduced. `build_and_deploy.yml` already creates the GitHub Release after its web and OTA steps by using `softprops/action-gh-release@v2`.

### Tagged deployment

The tagged workflow keeps its current job graph:

1. Resolve the deployment scope.
2. Deploy required backend and web components.
3. Re-run `build needed` and retain `native_build_needed` as the job output.
4. Build the mobile web assets.
5. Upload the OTA to the selected channel regardless of `native_build_needed`.
6. Create the GitHub Release only after the OTA succeeds.
7. If `native_build_needed` was `true`, request iOS and Android builds through their existing downstream jobs.

An OTA failure fails `deploy_webapp`. The GitHub Release is not created and the two native jobs do not start because they already require `deploy_webapp` to succeed.

### Native version synchronization

The root `package.json` in the tagged commit contains the version produced by `standard-version`. The existing CLI flags copy that value into the platform projects before upload:

- iOS automatic and manual release paths use `--sync-ios-version`.
- Android automatic and manual release paths use `--sync-android-version`.

No explicit version argument, new command, or native-compatibility version is added.

## Failure and retry behavior

- A pre-tag compatibility-check error fails before any version bump or tag.
- A second native-required bump after an incomplete tagged deployment fails before any version bump or tag. CI does not retry automatically.
- An OTA upload failure leaves the existing tag without a GitHub Release. Manually rerunning that tag's deployment retries the same release version.
- A native build-request failure happens after the OTA and GitHub Release. It does not roll back either one.
- Rerunning only a failed native job can reuse the successful prerequisite outputs. A future independent release is not guaranteed to resubmit a previously failed native build; this is an accepted limitation.
- The workflows continue using `@capgo/cli@latest`. Until a CLI version containing `--sync-android-version` is published, an Android request using that flag will fail visibly rather than silently building the wrong visible version.

## Files and responsibilities

- `.github/workflows/bump_version.yml`: determine the channel, run the pre-tag compatibility check, guard against a repeated major bump, and provide the final Capgo release severity to `standard-version`.
- `.github/workflows/build_and_deploy.yml`: always publish the OTA before the GitHub Release and apply both native version-sync flags to automatic builds.
- `.github/workflows/build_mobile_android.yml`: apply Android version synchronization to manually dispatched tagged builds.
- `.github/workflows/build_mobile_ios.yml`: retain and verify the existing iOS synchronization flag.
- `tests/capgo-release-workflow.unit.test.ts`: assert the workflow contracts without executing external releases.

## Tests

Workflow contract tests must prove that:

- The bump job still depends on successful scoped tests.
- Stable and development branches select `production` and `dev` respectively.
- Exit code `0` preserves the conventional release severity.
- Exit code `1` checks the latest reachable Capgo tag's GitHub Release and selects `major` only when allowed.
- Unexpected exit codes fail before `standard-version`.
- The tagged workflow uploads OTA without a native-compatibility condition.
- GitHub Release creation remains ordered after OTA upload.
- Automatic iOS and Android native jobs remain conditional on `native_build_needed == 'true'`.
- Every iOS build request uses `--sync-ios-version`.
- Every Android build request uses `--sync-android-version`.

## Non-goals

- Replacing `standard-version` or the current tag-triggered deployment architecture.
- Automatically rerunning failed tagged deployments.
- Waiting for App Store or Play Store review completion.
- Rolling back an OTA after a native build-request failure.
- Pinning the Capgo CLI to a particular published version.
