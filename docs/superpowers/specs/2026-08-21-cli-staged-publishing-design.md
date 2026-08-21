# CLI Staged Publishing Design

**Status:** Approved for implementation

**Date:** 2026-08-21

## Summary

Migrate the `@capgo/cli` tag release workflow from direct `bun publish` to the
staged npm publishing flow documented by `Cap-go/automations`. The public
`capgo.app` workflow will stage the package with the short-lived organization
`NPM_TOKEN`, then dispatch `npm-stage-approve` to the private automations
repository. The automations workflow remains responsible for npm login,
WebAuthn approval, and its scheduled approval fallback.

## Goals

- Publish stable CLI tags with npm's `latest` tag through `npm stage publish`.
- Publish alpha CLI tags with npm's `next` tag through `npm stage publish`.
- Request approval immediately after staging through a repository dispatch to
  `Cap-go/automations`.
- Keep npm credentials for staging and npm approval separated across the public
  and private repositories.
- Preserve the existing build, release changelog, prerelease, and GitHub release
  behavior.

## Non-goals

- Waiting for the approved version to become visible in the npm registry before
  creating the GitHub release.
- Changing the token renewer or stage approver in `Cap-go/automations`.
- Migrating the notifications or CLI-helper release workflows in this change.
- Changing organization secret values or repository access from this pull
  request.

## Selected Approach

Follow the `Cap-go/automations` integration contract directly:

1. Configure `actions/setup-node` with the npm registry.
2. Replace each direct `bun publish` command with `npm stage publish` from the
   `cli` working directory.
3. Supply the short-lived staging credential as `NODE_AUTH_TOKEN` from the
   organization `NPM_TOKEN` secret.
4. Dispatch the `npm-stage-approve` repository event to
   `Cap-go/automations`, including the source repository, run ID, and
   `@capgo/cli` package name.
5. Continue to the existing GitHub release step after GitHub accepts the
   dispatch; do not poll npm.

The dispatch uses `NPM_STAGE_DISPATCH_TOKEN`, a GitHub fine-grained token whose
only purpose is dispatching to `Cap-go/automations`. The npm bot password and
WebAuthn material stay exclusively in the private automations repository.

## Alternatives Considered

### Direct npm publishing with OIDC

Trusted publishing would remove the rotating token, but it bypasses the staged
approval system that the organization has already adopted.

### Direct publishing with a 2FA-bypass token

This would retain the current release shape, but the daily renewer intentionally
replaces `NPM_TOKEN` with a token that does not bypass 2FA. A separate direct
publish token would duplicate credentials and weaken the new approval boundary.

## Failure Behavior

- A staging failure stops the workflow before dispatch and GitHub release.
- A missing or unauthorized dispatch credential makes the dispatch step fail
  visibly instead of silently claiming approval was requested.
- Once the dispatch is accepted, approval is asynchronous. The automations
  repository retries newly created stages and its 15-minute schedule catches a
  missed or delayed dispatch.
- GitHub release creation retains its existing behavior and may complete before
  npm approval finishes.

## Configuration Prerequisite

The organization `NPM_STAGE_DISPATCH_TOKEN` secret must be available to the
public `Cap-go/capgo.app` repository. At design time it is restricted to private
repositories, so its repository access must be corrected separately before the
next CLI release.

## Testing

Add a focused unit assertion over `publish_cli.yml` proving that the workflow:

- uses `npm stage publish` for both stable and alpha releases;
- preserves the `latest` and `next` npm tags;
- uses `NODE_AUTH_TOKEN` and no longer uses `NPM_CONFIG_TOKEN` or
  `bun publish`;
- dispatches `npm-stage-approve` to `Cap-go/automations` with the dedicated
  GitHub secret; and
- keeps the dispatch before GitHub release creation.

Run the focused release-workflow tests and repository lint checks before
publishing the pull request.
