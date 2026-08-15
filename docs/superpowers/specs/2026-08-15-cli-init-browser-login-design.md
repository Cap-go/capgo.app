# CLI Init Browser Login Design

**Date:** 2026-08-15
**Status:** Approved design, pending written-spec review

## Problem

`npx @capgo/cli@latest init` currently needs an API key supplied as an argument,
environment variable, or saved `.capgo` credential. A new user who has none must leave
the CLI, create a suitable key manually, and restart or repeat the command.

The desired flow keeps API-key delivery intentionally simple: the CLI opens an
authenticated dashboard page, the page prepares a conservative key without asking the
user any configuration questions, and the user copies and pastes the secret into a
masked terminal prompt. The page then confirms the validated CLI login through the
existing backend event and Supabase Realtime path.

## Goals

- Let interactive `init` continue when no supplied or saved API key exists.
- Keep `/login-cli` zero-choice: no key name, organization, role, or expiry controls.
- Use only existing backend APIs and database schema.
- Reuse a suitable existing `Capgo CLI` key when its secret remains available.
- Create a conservative multi-organization key when reuse is impossible.
- Follow organization hashed-key and expiration policies automatically.
- Skip organizations whose permissions cannot be reproduced confidently and explain
  the omission on the page.
- Never grant the key `org.create`.
- Keep the secret hidden by default in both browser and terminal.
- Correlate Realtime success to the exact browser login attempt.
- Stay within an approximately 1,000-line total change budget.

## Non-goals

- No new backend route, database function, table, migration, queue, or cron task.
- No OAuth/device-flow polling or automatic secret transfer to the CLI.
- No permission picker or reuse of the `/connect` interaction flow.
- No recovery when a supplied or saved key exists but is expired, revoked, invalid, or
  under-scoped. Existing failure behavior remains unchanged.
- No changes to `capgo login` or other CLI commands unless a shared internal helper must
  be extracted without changing their behavior.
- No attempt to reproduce member, app-only, channel-only, custom, or ambiguous access.

## Architecture

The feature has three cooperating pieces:

1. `init` creates a random session nonce, opens `/login-cli?session=<nonce>`, and waits
   at a password-style prompt.
2. `/login-cli` uses the authenticated user's existing dashboard data and current API
   endpoints to reuse or create a key. It subscribes to existing organization-scoped
   CLI Realtime channels.
3. After validation and persistence, the CLI calls the existing `/private/events`
   endpoint once per organization visible through the key. Each console-only event
   carries the nonce in `description`. The page accepts only a matching nonce and then
   shows login success.

The only backend calls are existing organization/key reads, `POST /apikey`, and
`POST /private/events`. The existing event handler already verifies organization access
before broadcasting and skips analytics for `notifyConsole` events.

## CLI Behavior

### Entry conditions

The browser flow starts only when all of the following are true:

- `init` is running interactively;
- no positional API key was supplied;
- `CAPGO_TOKEN` and saved global/local `.capgo` lookup produce no key.

If a credential is found, `init` follows its current path. It does not pre-validate and
recover through `/login-cli`. Non-interactive or CI execution never opens a browser and
continues to require an explicit or saved credential.

### Browser launch and input

- Generate a cryptographically random, URL-safe nonce with at least 128 bits of entropy.
- Open `${consoleWebUrl}/login-cli?session=<nonce>` using the CLI's existing browser-open
  dependency.
- Always print the URL as a fallback for SSH, blocked browser launch, or another device.
- Prompt for the API key with a password-style input whose rendered characters are `*`.
- Do not place the secret in command arguments, ordinary text prompts, logs, spinners,
  errors, analytics, or terminal replay content.
- Validate and persist the pasted key through the existing `validateAndSaveKey` core,
  preserving the global `~/.capgo` mode `0600` behavior.

### Realtime login confirmation

After the key is validated and saved:

- Use the authenticated key to list its organizations through the existing CLI/Supabase
  organization lookup.
- For every returned organization, send an existing events request with:
  - `event: 'User CLI login'`
  - `channel: 'user-login'`
  - `tracking_version: 2`
  - `org_id: <organization id>`
  - `description: 'cli-login:<nonce>'`
  - `notifyConsole: true`
  - `notify: false`
- Treat event delivery as best effort. A broadcast failure must not undo a valid saved
  login.
- Console-only workflow delivery must still run when analytics is disabled. The CLI
  telemetry guard may skip ordinary tracking, but it must not suppress
  `notifyConsole: true`; the backend already excludes such events from tracking.

The page subscribes only to channels for organizations included in its prepared key and
accepts only `User CLI login` with the exact nonce description. Duplicate broadcasts
from a multi-org key collapse into a single success transition. The general dashboard
CLI feed ignores the `user-login` channel so the correlation description does not
appear as an unrelated global toast.

## Frontend Organization Selection

The page waits for authenticated session and organization-store loading before doing
anything. Normal auth middleware preserves the full `session` query when redirecting
through `/login`.

An organization is eligible only when all checks are clear:

- it is not a pending invitation;
- the user satisfies its 2FA and password-policy access gates;
- its reported role is one of the recognized mappings below;
- existing frontend permission checks confirm both `org.manage_apikeys` and
  `org.update_user_roles` for that organization.

Recognized mappings:

| User organization role | Generated API-key binding |
| --- | --- |
| `owner` | `org_super_admin` at organization scope |
| `org_super_admin` | `org_super_admin` at organization scope |
| `org_admin` | `org_admin` at organization scope |

Skip `org_member`, `org_billing_admin`, missing/unknown roles, app-only or channel-only
access, pending invitations, failed permission checks, and permission-check errors. The
page never guesses, retries with a broader role, or adds app/channel bindings.

Skipped organizations appear in a compact warning by name. If every organization is
skipped, do not call the creation endpoint; show a clear no-eligible-organization state
and a Dashboard button.

## Key Policy Aggregation

The page derives one policy for the multi-org key:

- `hashed` is true when any eligible organization has
  `enforce_hashed_api_keys = true`.
- `expires_at` is null when no eligible organization requires expiration.
- When at least one requires expiration, use the strictest positive
  `max_apikey_expiration_days` from every eligible organization. An organization with a
  max still constrains the shared expiry even when it does not itself require expiry.
- If expiration is required but no eligible organization supplies a maximum, use the
  dashboard policy control's maximum supported duration of 365 days.
- Subtract a small request-clock safety margin from the calculated maximum so network
  delay cannot make `POST /apikey` exceed the policy by milliseconds.

The existing endpoint remains the final policy authority. The page displays a warning
when hashing, expiration, or both were applied, including the formatted expiration date.
Hashing does not prevent showing a newly created secret: the creation response contains
the plaintext once while only its hash remains stored.

## Existing-Key Reuse

### Candidate boundary

Only inspect keys owned by the current user whose names match exactly:

- `Capgo CLI`
- `Capgo CLI (N)`, where `N` is an integer of 2 or greater

Do not treat arbitrary names beginning with the same text as managed CLI keys. Fetch
public key metadata and global permissions through the existing `GET /apikey`, fetch
candidate role bindings through the existing RLS-protected `role_bindings` query, and
merge owned plaintext key material through the existing owner-select policy on
`apikeys`.

### Exact match

Canonicalize expected and candidate binding sets by role, scope, organization, app, and
channel identifiers. A candidate is reusable only when:

- its canonical binding set exactly equals the expected eligible organization bindings;
- `global_permissions` is empty, including no `org.create`;
- it is not expired;
- it has a non-null plaintext `key` value;
- it is usable under current hashed-key and expiration policies.

Extra, missing, app-level, channel-level, compatibility, or system-created bindings make
the candidate ineligible. Exact equality ensures a downgraded user cannot recover an
older, more powerful key.

When multiple candidates qualify, choose deterministically by numeric name order
(`Capgo CLI` before `(2)`, `(2)` before `(3)`), then newest creation time for duplicate
names. The page states that an existing key was reused.

Previously hashed keys cannot be reused because their plaintext is intentionally
unrecoverable. They still reserve their names.

### New name allocation

If no key qualifies, choose the smallest unused managed name:

1. `Capgo CLI`
2. `Capgo CLI (2)`
3. `Capgo CLI (3)`
4. Continue monotonically through the first gap.

Call the existing `POST /apikey` with the fixed name, aggregated `hashed` and
`expires_at` values, expected bindings, and `global_permissions: []`. Creation is atomic;
if the endpoint rejects any organization because state changed after preflight, show an
error and retry action rather than parsing the error and silently weakening the scope.

## `/login-cli` Page States

The route requires a valid high-entropy `session` query from `init`. A direct visit
without it does not create a key; it shows the public `npx @capgo/cli@latest init`
instruction and a Dashboard button. This prevents accidental key generation and avoids
an uncorrelatable waiting state.

### Preparing

Show a focused card with “Preparing your CLI key…” while organizations, permissions,
candidate keys, bindings, and policies load. There are no editable controls.

### Ready and waiting

The secret card contains:

- a fake value such as `capgo_xxxxxxxxx…` in the DOM;
- a milky blur treatment over that fake value;
- “Reveal API key,” which swaps the real in-memory secret into the DOM and can toggle
  back to the fake hidden value;
- a Copy button that copies the real secret without revealing it;
- a note that copying leaves the key hidden;
- a warning not to paste the key into untrusted places;
- policy and skipped-organization warnings when applicable;
- a waiting indicator for CLI confirmation.

The real key is never rendered underneath CSS blur. It enters the DOM only while reveal
is active. On re-hide, success, or unmount, remove it from rendered state; on success,
also clear the in-memory secret after the page no longer needs copy/reveal.

### Success destination

After the matching Realtime event, query the user's accepted, non-invite organizations
and apps using existing RLS:

- If the user belongs to exactly one organization, that organization has exactly one
  app, and the app has `need_onboarding = true`, show “Continue the setup” and navigate
  to `/app/new?resume=<encoded app id>`. Existing onboarding persistence decides the
  resumed step.
- Otherwise show “Go to the dashboard” and navigate to `/dashboard`.

Do not base this decision only on eligible key organizations; a skipped second
organization still means the user belongs to more than one organization.

## Error Handling

- Auth redirect: preserve the nonce and return to `/login-cli`.
- Organization or permission lookup failure: fail closed for the affected organization
  and list it as skipped.
- Candidate/key metadata lookup failure: fail the preparation state rather than risk
  duplicate naming or unsafe reuse.
- Creation failure: show the backend message when safe, otherwise a localized generic
  failure with Retry and Dashboard actions.
- Clipboard failure: keep the key available and show a localized copy error.
- Realtime connection failure: keep copy/reveal usable and explain that automatic
  confirmation is unavailable; the terminal login can still succeed.
- Invalid pasted key: preserve current CLI failure behavior and keep the browser waiting.
- Browser close or timeout: no cleanup or key revocation occurs. A successfully created
  key remains a normal dashboard API key.

## Component Boundaries

Keep the large existing files from absorbing more orchestration:

- `src/pages/login-cli.vue`: page state, rendering, Realtime subscriptions, and routing.
- A small frontend service/helper module: organization classification, policy
  aggregation, managed-name parsing/allocation, canonical binding comparison, and
  reuse/create orchestration through existing clients.
- A small CLI browser-login helper: nonce generation, URL opening, masked prompt, key
  validation call, and console-notification fan-out.
- Minimal wiring in `cli/src/init/command.ts` at the current missing-login branch.

Do not import `/connect` components. Small generic copy or API-key utility functions may
be shared only when doing so keeps both callers simpler and preserves `/connect`
behavior.

## Security Properties

- JWT and existing backend authorization remain authoritative for key creation.
- Unknown or ambiguous access is excluded, never elevated.
- The key exactly matches known eligible organization roles and has no global grants.
- Existing RLS protects candidate key material and role-binding reads.
- A high-entropy nonce prevents unrelated CLI activity from completing the page.
- The nonce is not a credential and carries no permission; the API key still
  authenticates the event endpoint.
- The secret is hidden in the browser by real data separation, not cosmetic blur alone.
- The terminal uses masked input and existing secret-redaction/persistence safeguards.
- Organization security policy is respected rather than bypassed.

## Testing

### Frontend unit tests

- Recognized admin roles map correctly; member, billing, invite, non-compliant,
  ambiguous, and failed-check organizations are skipped.
- Hashing and strictest expiration aggregation cover single- and multi-org policies,
  the 365-day no-max fallback, and clock-skew margin.
- Managed key names parse strictly and allocate the first available suffix.
- Canonical binding equality rejects extra, missing, app, channel, compatibility, and
  global permissions.
- Reuse rejects hashed, expired, policy-incompatible, and plaintext-missing keys.
- Success routing selects onboarding only for exactly one org with exactly one pending
  app.

### Frontend page tests

- Missing session does not create a key.
- Preparing has no controls; ready renders only the fake secret until Reveal.
- Copy uses the real secret without revealing it; re-hide removes the real value.
- Policy and skipped-org warnings render only when applicable.
- Only a matching event name and nonce completes the page; duplicates are harmless.
- The general CLI activity feed suppresses login-handshake events.
- Realtime failure leaves the manual paste path usable.

### CLI tests

- Missing supplied/saved key in an interactive `init` opens the URL and uses masked
  input.
- Supplied, environment, global, and local keys bypass browser login.
- Invalid existing keys do not trigger recovery.
- CI/non-interactive mode never opens a browser.
- The secret is absent from captured output and errors.
- A successful login emits one console notification per accessible organization with
  the exact nonce.
- Console notifications are not suppressed by analytics opt-out.

### Verification commands

- Focused frontend and CLI unit tests.
- `bun lint`
- `bun typecheck`
- `bun run cli:check`
- `bun build`

## Scope Control

This design deliberately avoids backend and schema work, permission-picker extraction,
device-flow infrastructure, invalid-key recovery, and unrelated onboarding refactors.
New logic should be organized as small pure helpers plus thin page/CLI orchestration so
the total change remains near or below 1,000 lines including focused tests.
