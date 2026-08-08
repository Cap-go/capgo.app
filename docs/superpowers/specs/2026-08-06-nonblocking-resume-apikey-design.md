# Nonblocking Resume API Key Design

## Problem

Opening `/app/new?resume=<app-id>` currently keeps the entire onboarding page behind its full-page spinner until `ensureApiKey()` finishes. API-key discovery and creation can take roughly ten seconds, even though the resumed app can be loaded and displayed independently.

## Design

Load the resumed app before starting API-key provisioning. Once the app-loading decision is complete, clear the page-level loading state and run `ensureApiKey()` asynchronously. The existing CLI command card remains responsible for showing “Creating your secure API key…” and disabling copying until `apiKey` becomes available.

Keep API-key failures non-fatal. Preserve the existing console logging and localized toast while leaving the resumed app usable. Do not change the API-key endpoint, permissions, creation semantics, or non-resume onboarding flow.

## Alternatives Considered

- Parallelize `loadResumeApp()` and `ensureApiKey()` but await both: reduces total elapsed time slightly, but still blocks the whole page on key creation.
- Create the key during app creation: could remove the later wait, but couples backend operations and expands the change beyond the frontend UX defect.
- Recommended: render first and provision in the background. This is the smallest behavioral change and matches the command-card loading state already implemented by PR #2877.

## Testing

Add a focused source-level regression assertion that the mounted resume flow loads the app before starting `ensureApiKey()` and does not await the key promise. Retain the existing command loading and copy-disabled assertions.
