# Builder Init Login Gate Design

## Goal and scope

Make direct `npx @capgo/cli@latest build init` authenticate before the user
selects iOS or Android and before either platform loads saved onboarding
progress. Keep the login experience in Builder's existing full-screen Ink
wizard. This is the first, independently releasable PR in the broader Builder
onboarding work.

This PR checks that a key identifies a Capgo user. It does not decide whether
the key can see or build a particular app. App confirmation, app creation,
`app.build_native` permission checks, `capgoBuilderAppId`, web-created app ID
reuse, and Builder v4 todo items belong to later PRs. The identity check must
not describe an app-scoped key as fully authorized for Builder.

`build init` and its `build onboarding` alias already accept `-a, --apikey`.
This PR keeps that interface. The login gate also applies when Builder
onboarding is launched through an existing wrapper command, since those paths
use the same shell. The browser choice is offered only for the hosted Capgo
console; custom `--supa-host` or `--supa-anon` runs use manual key entry, as OTA
onboarding does today.

## Existing behavior and chosen approach

The OTA init flow already offers browser or manual key entry, validates the key,
and saves an interactively entered key. Its browser helper opens the correlated
`/login-cli?session=...` page and can be given a custom prompt. Builder already
has full-screen `OnboardingShell`, `CardChooser`, and a masked Ink input.

Use a new Builder Ink login screen and share the OTA browser session and
validation behavior through UI-free helpers. Keep OTA's current Clack/Ink
presentation and its public helper contract. Sharing OTA's visual screen would
mix two different presentation systems; duplicating the login service would
let their behavior drift.

Two smaller alternatives were considered:

1. A Clack prompt before Builder's Ink render changes terminal mode between
   login and platform selection and does not match Builder's full-screen flow.
2. A standalone second Ink app for login introduces an alternate-screen exit
   and re-entry between login and the platform picker.

The selected design adds the login state to the existing `OnboardingShell` so
project discovery, update prompt, login, and platform selection can use one Ink
instance. The update prompt remains first when available; the login gate comes
immediately after it and always before the platform picker or automatic
platform progress load.

## Key resolution and transitions

Resolve the candidate key with this precedence: non-empty `--apikey`, then
`CAPGO_TOKEN`, then global `~/.capgo`, then project-local `./.capgo`. This
matches the existing saved-key lookup. A command-line key is for the current
run; validating it does not silently save it. A key entered through either
login choice is validated and saved globally through the existing auth helper.
The validated key is passed explicitly to the iOS, Android, or Appflow child
flow and retained for the post-exit quit event. No child flow has to rediscover
the key from disk.

The gate validates an existing candidate with the same quiet user-identity
lookup used by OTA. A valid candidate advances without a login-choice screen.
An absent or rejected candidate shows the login screen. A request that cannot
reach Capgo stays at the gate and offers retry or another key; it does not
continue with an unverified key. Authentication errors stay inside Ink while
Ink is mounted.

Submitting a key shows a verifying state and disables repeat submission. An
empty value leaves the user on the field with a short error. A rejected key
keeps the input screen available for another paste. The browser session and
URL stay stable while the user corrects a pasted key, so a typo does not open
another browser tab. If opening the browser fails, the URL remains visible for
manual opening. Escape from the login screen cancels onboarding and restores
the normal terminal; existing completion/quit handling applies.

Identity validation is distinct from app access. A valid key with no access to
the configured app advances in this PR. The later app-selection PR will check
visibility and permissions before onboarding continues.

## Full-screen copy and layout

The login-choice screen uses the existing framed Builder header and the same
responsive card/list layout as the platform picker:

> How would you like to log in?
>
> 🌎 Open browser — Create key in Dashboard
>
> 📋 Paste API key — Use an existing key

The short card hints fit the existing card widths. Both paths lead to a
separate, bordered masked entry area headed:

> Paste the API key from the Capgo Dashboard

The browser path also shows the generated URL, with a concise fallback note if
the browser did not open. On small terminals, the key input uses a plain,
unboxed masked prompt similar to OTA; the same choice and validation flow stays
available. The input shows a bounded number of mask characters even when a
long key is pasted; it retains and submits the whole value. Key
characters never appear in the rendered frame, normal output, support log, or
telemetry. The field accepts a user-initiated terminal paste. The CLI does not
read the macOS clipboard automatically and does not impose a UUID-only format
on keys.

At small terminal sizes, the existing `44 × 11` picker floor and responsive
list layout apply. The bordered key input appears only when the whole input
view fits; the unboxed prompt is used otherwise. The login view must not clip
at the picker floor; the existing resize prompt covers smaller terminals.
Authentication stays ahead of an
explicit `--platform` and ahead of the single-native-folder auto-selection.

## Telemetry and privacy

Existing CLI events need an API key. The UI holds only a small, in-memory
summary while login is pending. After successful validation, emit one
`Builder Onboarding Login` event on the `builder-onboarding` channel with the
existing `journey_id`, login method (`browser` or `paste`), retry count, and
elapsed time. The event itself means the login screen was shown. It has no
platform yet and does not require an owner org. No key, browser session URL,
or pasted text is included. If an existing/explicit key validates without
showing the login screen, no login-screen event is emitted.

The direct `build init`/`build onboarding` command invocation event is deferred
and flushed after a key validates, matching OTA's authenticated invocation
behavior. It remains impossible to count launches that exit before any key
validates through this authenticated event path. That gap is accepted here.
`--no-analytics` and the existing telemetry opt-out environment variables
suppress both events. Sending telemetry is best effort and must not delay the
transition to platform selection or turn a successful login into an error.

The current terminal replay starts only when a key exists at launch. Adding a
late-start replay for previously signed-out runs is outside this PR; the new
login screen still lives in the same full-screen Ink tree. Replay must never
record unmasked key text.

## Verification and release boundary

Automated checks should cover candidate-key precedence and validation;
full-screen ordering with and without `--platform`; browser-open fallback;
manual paste; invalid-key retry; saved/explicit key behavior; key propagation
to platform children and quit telemetry; narrow terminal rendering; and the
post-auth login event with analytics opt-out. Existing OTA browser-login tests
must continue passing after the shared helper extraction.

Manual terminal checks should verify the card layout, masked bordered input,
browser URL, keyboard paste, Escape, and that no auth error prints outside Ink.
Run `bun run cli:check` before opening the PR. The PR is expected to touch
roughly six to eight CLI source files plus focused tests; no database or web
console change is needed.
