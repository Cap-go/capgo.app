# Builder Init App Selection Design

## Goal and PR boundary

Make `npx @capgo/cli@latest build init` choose an accessible Capgo app before it
selects a platform or loads saved Builder onboarding progress. Reuse an app
already created in the Dashboard, including one with `need_onboarding`, instead
of assuming the Capacitor ID is the right Capgo ID or creating a duplicate.
Require the active API key to have `app.read` and `app.build_native` for the
chosen app. Keep every question and error inside Builder's existing full-screen
Ink wizard.

This is the **selection PR**. It lists and verifies existing apps, can open the
Dashboard for manual creation, and can switch API keys. It does not create an
app, choose an organization, or change `need_onboarding` itself. A second PR
will add in-CLI app creation and an organization picker with
`org.create_app` authorization.

The design applies to `build init`, its `build onboarding` alias, and existing
wrapper commands that enter the same Builder onboarding shell. It does not
change general Builder app ID resolution or other Builder commands before the
user chooses an app.

## Chosen approach

Add one app-selection gate to the existing `OnboardingShell`, immediately
after the login gate and before the platform picker, automatic platform load,
and resume prompt. Extract a quiet, paginated `GET /app` service from the app
list command. Use the existing API key and custom-host options, then check the
selected app's read and native-build permissions. Pass the resolved ID to all
platform children and their progress loaders. The selected ID must not be a
fixed prop captured before login.

Two alternatives add more complexity or risk:

1. A separate Clack prompt before Ink would print outside the full-screen
   wizard and split ownership of errors and terminal rendering.
2. Confirming an exact app ID match would interrupt the common path without
   helping the user resolve an ambiguity. The matching app is already the
   intended default; a permission check is still required.

No backend or database change is expected. `GET /app` already scopes the list
to what the API key can see, and the permission RPC can check
`app.build_native` for a specific app.

## Suggested ID and exact match

The suggestion for this gate is `plugins.CapgoBuilder.capgoBuilderAppId` when
set; otherwise it is the **top-level** Capacitor `appId`. Do not use
`plugins.CapacitorUpdater.appId` as this gate's suggestion. That Updater ID may
intentionally differ from the native app ID. Existing validation of a malformed
Builder override remains in place. If neither the Builder override nor the
native ID is usable, show the existing config error before API work.

Fetch all visible app pages before deciding there is no exact match. If a
visible app's `app_id` exactly equals the suggested ID, verify `app.read` and
`app.build_native`, then continue automatically to the platform flow. There is
no confirmation screen, whether the key sees one app or many. A permission
denial or API error must stop this automatic path and show recovery inside Ink.
Absence from the list means only that the current API key cannot see that ID;
it does not prove the app is absent from Capgo.

## No-match screen

Use one responsive full-screen screen for one or many visible apps. The
question is **“Which Capgo app should Builder use?”** It shows the suggested
ID as **“Your Capacitor app ID”** when sourced from the native config, or
**“Your Builder app ID”** when sourced from the Builder override. The notice
reads:

> No app with this ID is available to your API key. It may exist in Capgo, but
> you or your API key might lack access to it.

If exactly one app is visible, label it **“App visible to your API key:”** and
show its name (or its ID if unnamed) and full ID as a selectable row. There is
no “Select a different app” action in this case. If several are visible, label
the list **“Apps
visible to your API key (closest IDs first):”** and show at most three
selectable app rows. Rank by a deterministic, locally computed ID similarity
to the suggested ID; prefer a longer shared reverse-domain prefix, then a
higher normalized edit similarity, then lexical `app_id` order. Similarity is
only presentation order and never selects an app automatically.

Show **“Select a different app…”** whenever more than one app is visible. It
opens a searchable, scrollable full list of the same API-visible apps; search
matches app name or ID. Choosing any app is an explicit action. The other
actions on the no-match screen are **“Log in
with another API key”** and **“Open Dashboard to create &lt;suggested ID&gt;”**.

If no app is visible, use the same heading, suggested ID, and notice, followed
by **“No apps are visible to this API key.”** Show the other-key and Dashboard
actions without an app row or full-list action.

The Dashboard action opens the app-creation page and creates nothing in the
CLI. The wizard then offers **“I've created it — check again”**; choosing it
re-fetches the list. A newly created app can be used only if the active key
can read and build it. The Dashboard has its own browser session and
authorizes creation there. The CLI does not infer
`org.create_app` for that session from the current CLI key. If the browser
opens under a different account, the user can switch the CLI key. An
unavailable browser leaves a URL the user can open manually.

## Verification, persistence, and recovery

After a row is chosen, perform a targeted app read and a quiet
`app.build_native` permission check for that app. Use the existing API host
and API key. A list result alone is insufficient: the list is org-scoped and
does not prove both app permissions. A denied read, missing app, or denied
build returns to an Ink recovery state explaining the required permission;
offer another key and another visible app where one exists. Network and API
failures show retry and another-key actions. Never present a failed list fetch
as “no apps,” and never print Clack errors while Ink is mounted.

Once verification succeeds, persist `plugins.CapgoBuilder.capgoBuilderAppId`
only when the effective Builder ID for later commands would otherwise differ
from the chosen ID. This includes choosing the native Capacitor ID when the
legacy Builder fallback would have used a different Updater ID. Preserve all
other Capacitor config fields through the existing config writer. A failed
write leaves the user at an Ink error/retry state; onboarding does not proceed
with an unpersisted ID. No write is needed when the existing Builder resolver
already returns the chosen ID.

Then pass that same ID to iOS, Android, Appflow, progress loading, support
logging, completion output, and subsequent telemetry. Keep native iOS bundle
ID and Android package-name defaults sourced from the top-level Capacitor
config; selecting a Capgo app does not rewrite native package identities.
Saved progress under a different Capgo app ID is not silently resumed for the
chosen app. Existing resume behavior applies only after the chosen ID is
known.

The “Log in with another API key” action reopens Builder's existing full-screen
login choice even if the current key is valid. The replacement key is validated
through the existing login service; then the app list and permissions are
rechecked. Cancelling the switch returns to the app screen with the original
key. No key contents appear in Ink, logs, or telemetry.

## Telemetry and verification

After login, emit best-effort app-gate telemetry on the existing
`builder-onboarding` channel with the `journey_id`. Record that the gate was
shown, whether it resolved by exact match or a selected row, the number of
visible apps, selected row source (`closest_list` or `full_list`), and
permission-denial or API-error categories. Mark `app-selection` as the current
onboarding step so the existing quit event identifies exits here. Do not send
app names, API keys, search text, or Dashboard URLs. Keep `--no-analytics` and
existing telemetry opt-outs effective. Telemetry failure never blocks the
wizard. The login event remains sent after authentication as it is today.

Focused automated tests should cover: override/native suggestion precedence;
paginated listing and failed-list handling; exact match with one or many apps
without a prompt; no-match ordering and the one-app/zero-app UI; full-list
search; both permission checks; key switch and re-list; Dashboard return and
re-list; config-write success/failure; pending Dashboard-created app reuse;
selected ID propagation before `--platform` auto-load and resume; narrow
terminal rendering; custom API host; and telemetry opt-out. Manual checks
should cover the alternate-screen layout, keyboard navigation, browser
handoff, and errors staying inside Ink. Run `bun run cli:check` for the PR.

The implementation should stay in the CLI workspace. No schema, web console,
or general OTA onboarding change belongs in this PR.
