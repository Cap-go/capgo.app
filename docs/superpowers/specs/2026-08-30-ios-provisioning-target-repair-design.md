# iOS provisioning target repair

## Problem

Capgo Builder stores iOS provisioning profiles in
`CAPGO_IOS_PROVISIONING_MAP`, keyed by the concrete bundle identifier that the
builder must sign. A Capacitor project can gain additional signable Xcode
targets after its initial Builder setup, such as a widget or notification
service extension. Each target normally has its own bundle identifier, but the
saved map commonly contains only the main app entry. The existing prescan blocks
the build, and the only repair path is to create profiles manually and pass
repeated `--ios-provisioning-profile` arguments.

Some existing profiles are wildcard profiles. A wildcard profile already stored
in the map may cover a newly added target, but the builder still needs an exact
map key for that target. Today the CLI neither offers to copy the wildcard map
entry nor distinguishes that repair from creating a new Apple provisioning
profile.

## Goal

Add an interactive command:

```text
npx @capgo/cli@latest build credentials ios-provisioning [--local|--global]
```

The command discovers every signable iOS target, reports whether every target
has an exact saved map entry, offers to assign one existing wildcard profile to
new targets it covers, and creates App Store provisioning profiles for targets
that remain uncovered. Prescan must block incomplete multi-target builds and
direct users to this command.

The feature may add at most 1,100 production implementation lines under
`cli/src`, excluding tests and specification files.

## Non-goals

- Do not support ad-hoc, development, or enterprise profile generation.
- Do not create or modify the P12 signing certificate.
- Do not support choosing among multiple different wildcard profiles.
- Do not add non-interactive confirmation flags such as `--yes`.
- Do not change the Builder payload, backend API, database schema, or iOS
  onboarding state machine.
- Do not create wildcard provisioning profiles through Apple.

## Command interface

Register `ios-provisioning` below `build credentials`. CLI command names remain
lowercase kebab-case. The command accepts only `--local` and `--global`; they are
mutually exclusive. It intentionally has no `--appId` option because it must run
inside the Capacitor project whose Xcode targets it inspects.

Resolve the saved-credential app key with the same `getAppId(undefined, config)`
behavior used by existing Builder credential commands. This preserves the
`plugins.CapacitorUpdater.appId` override. Provisioning-map keys never use that
value blindly: they come from each Xcode target's concrete Release-preferred
`PRODUCT_BUNDLE_IDENTIFIER`.

## Architecture

### Command orchestrator

Add `cli/src/build/ios-provisioning-command.ts`. It owns project validation,
credential-store selection, prompts, Apple API orchestration, incremental
persistence, and terminal summaries. Its dependencies should be injectable
where I/O or Apple calls would otherwise make tests non-hermetic.

The command reuses existing code for:

- Capacitor config loading and custom `ios.path` resolution;
- Xcode project discovery and `findSignableTargets`;
- saved credential reads and `updateSavedCredentials`;
- mobile provisioning parsing;
- P12 opening and leaf-certificate SHA-1 extraction;
- App Store Connect JWT generation and key verification;
- Apple certificate lookup by SHA-1;
- bundle-ID registration, profile creation, duplicate discovery/deletion; and
- Clack confirmation, cancellation, and safe terminal logging conventions.

### Shared provisioning-map analyzer

Add `cli/src/build/ios-provisioning-map.ts`. This module is pure apart from
calling the existing pure profile parser. Both the command and prescan use it so
exact coverage and wildcard decisions cannot drift.

The analyzer accepts discovered targets and a parsed provisioning map. It
returns:

- targets already covered by an exact own-property map key;
- targets missing an exact entry;
- targets whose bundle identifier is missing, unresolved, or non-concrete;
- the one reusable wildcard profile, when one exists;
- missing targets covered by that wildcard;
- missing targets that still require profile generation; and
- an unsupported wildcard conflict when more than one distinct matching
  wildcard profile exists.

Targets are grouped by concrete bundle identifier for profile work while
retaining every target name for messages. This prevents duplicate Apple calls
if a malformed project repeats a bundle identifier, without hiding which Xcode
targets share it.

Map entries use the current canonical shape
`{ profile: string, name: string }`. The analyzer may read the tolerated legacy
string value shape already understood by prescan, but all newly generated
entries use the canonical object shape. Existing unrelated map entries are
preserved.

Exact coverage means `Object.hasOwn(map, target.bundleId)`. A wildcard map key
alone is not an exact assignment. Wildcard capability is derived from the
profile's embedded application identifier:

- `*` covers every concrete bundle identifier;
- `com.example.*` covers identifiers beginning with `com.example.`; and
- all other embedded identifiers require an exact match.

Distinct wildcard profiles are compared by their stored profile bytes. The same
profile repeated under multiple keys counts once even if display-name metadata
differs. When missing targets are matchable by more than one distinct wildcard
profile, analysis reports an unsupported conflict; the CLI will not invent a
selection policy.

Structurally invalid maps, invalid entries, or profile bytes that cannot be
parsed are fatal command validation errors naming only the affected map key.
Credential or profile contents are never included in errors.

### Credential-store selection

Extract the credential-store decision from
`credentials-export-command.ts` into a small shared helper and keep export's
observable behavior unchanged. The new command uses the same contract:

- reject `--local` together with `--global`;
- when neither is passed, choose the only store configured for the app;
- when both stores configure the app, fail and require one selector;
- an explicit selector never falls back to the other store; and
- unreadable or malformed selected storage fails instead of silently falling
  back.

The command reads the selected store's iOS credentials and writes every map
update back to that same store. `updateSavedCredentials` receives
`local: source === 'local'` explicitly.

## Command flow

### 1. Validate the project and saved state

1. Load Capacitor config from the current directory. Failure means this is not a
   usable Capacitor project.
2. Resolve the configured iOS directory, locate its Xcode project, and read the
   pbxproj. Fail if iOS is not configured, no signable targets exist, or any
   signable target lacks a concrete bundle identifier.
3. Resolve the saved-credential source using the shared export rules.
4. Require iOS credentials and a valid, non-empty
   `CAPGO_IOS_PROVISIONING_MAP` in that source. A completely absent map remains
   an initial credential-setup problem; this repair command does not bootstrap
   the first profile.
5. Reject `CAPGO_IOS_DISTRIBUTION=ad_hoc`. This command supports App Store
   profiles only.

If every concrete target already has an exact map entry, print that all targets
have provisioning profiles saved in Capgo and exit successfully without
requiring Apple API credentials.

### 2. Reuse one existing wildcard profile

Analyze missing exact entries against the embedded identifiers of profiles
already stored in the map.

If more than one distinct wildcard profile matches the missing targets, stop
with an error equivalent to: "Sorry, multiple matching wildcard provisioning
profiles are not supported." Do not offer a selector or mutate the map.

If one wildcard profile covers one or more missing targets, list their target
names and bundle identifiers and ask whether to update the map so those targets
use that wildcard profile. Confirmation is mandatory. On acceptance, copy the
same stored profile bytes into a canonical entry under every covered target's
exact bundle identifier and persist the whole wildcard batch in one local
write. On decline, leave those targets missing so the dedicated-profile flow
can offer to generate profiles for them.

Recompute coverage after the wildcard decision. If no targets remain missing,
report success. This wildcard-only path requires no `.p8` because it performs no
Apple request. Saved app-specific-password fields are ignored rather than used.

### 3. Validate Apple access for generation

When targets remain missing, require:

- `BUILD_CERTIFICATE_BASE64`;
- `APPLE_KEY_ID`;
- `APPLE_ISSUER_ID`; and
- base64-encoded `APPLE_KEY_CONTENT`.

Open the P12 with `P12_PASSWORD ?? ''` so an intentionally passwordless P12
continues to work exactly as it does in existing Builder flows.

App-specific-password credentials are never used for provisioning. If the
`.p8` trio is absent or incomplete, fail with a message explaining that
app-specific passwords cannot create provisioning profiles. If a complete
`.p8` trio exists, ignore app-specific-password fields.

Decode and locally validate the `.p8` before prompting for profile generation.
Then list every still-missing target and ask once whether to create its App
Store provisioning profile. Declining exits non-zero without Apple mutations.

After confirmation:

1. Generate a fresh JWT and call the existing App Store Connect verification
   helper. Invalid key material, rejected credentials, missing agreements, or
   insufficient access are fatal.
2. Open the saved P12 with the saved password and obtain its leaf-certificate
   SHA-1.
3. Find the matching Apple-side distribution certificate with that JWT. If it
   is not visible, fail before creating bundle IDs or profiles; this proves the
   `.p8` cannot operate on the saved signing certificate's team.

Neither the `.p8`, JWT, P12, passwords, certificate bytes, nor provisioning
profile bytes may appear in terminal output or logs.

### 4. Generate and persist exact profiles

Process the remaining unique bundle identifiers sequentially:

1. Ensure the bundle identifier exists through the existing Apple helper.
2. Create an `IOS_APP_STORE` profile linked to the matched distribution
   certificate, using the existing profile-generation helper.
3. On `DuplicateProfileError`, list the Capgo-managed duplicate profile names
   and ask whether to replace them for this target. If accepted, delete only the
   profiles returned by the existing Capgo-named duplicate lookup and retry
   creation once. If declined, stop without deleting anything.
4. Store the returned profile bytes and name under the target's exact map key.
5. Persist the updated map immediately before starting the next target.

Incremental persistence makes the command resumable. If a later Apple call
fails, earlier exact entries remain saved and a rerun skips them. If duplicate
deletion succeeds but recreation fails, report that target-specific state and
tell the user to rerun; do not conceal the remote mutation.

Finish with a per-target summary distinguishing already configured, wildcard
reused, and newly generated entries.

## Prescan design

Prescan remains read-only and blocks before `/build/request`, so neither a
server-side job nor an upload occurs while exact target mappings are missing.

### Edit `ios/targets-covered`

Use the shared analyzer and exact own-key coverage. Continue emitting a fatal
error for targets without exact entries. Exclude targets owned by the wildcard
finding below so the same target is not reported twice.

Change the check's applicability so a present but empty, malformed, or
structurally invalid map cannot evade coverage analysis. In that case emit one
fatal invalid-map finding with the existing general save/update guidance; do
not recommend `ios-provisioning`, because the repair command intentionally
requires a valid initial map.

For a multi-target project whose uncovered targets cannot reuse the one
supported wildcard profile, list those targets and recommend:

```text
npx @capgo/cli@latest build credentials ios-provisioning
```

For a single-target inconsistency, retain the existing general credential
repair guidance. A completely absent map remains owned by the existing fatal
`shared/credentials-saved` check and does not recommend a command that will
refuse to bootstrap the first profile.

### Add `ios/wildcard-profile-targets`

Register a fatal iOS check that runs only when a valid map exists and at least
one concrete target lacks an exact entry.

- With one distinct wildcard profile covering missing targets, list those
  targets and recommend `build credentials ios-provisioning`, which owns the
  required confirmation and map mutation.
- With multiple distinct matching wildcard profiles, report that automatic
  wildcard reuse is unsupported and require manual cleanup. Do not recommend an
  operation the command will refuse.
- Emit nothing when every target has an exact entry or no wildcard covers a
  missing target.

Existing checks for profile expiry, profile type, embedded bundle matching,
certificate pairing, entitlements, P12 validity, and App Store Connect access
remain responsible for their current concerns.

## Error and cancellation behavior

- Project, target, store, map, distribution, and local credential validation
  happens before mutation.
- Prompts are required for wildcard copying, profile generation, and duplicate
  replacement. If a required prompt cannot run interactively, fail with an
  actionable message. Do not add an automatic-confirmation flag.
- Cancellation and unsupported configurations exit non-zero.
- Apple failures stop the current run and identify the target without exposing
  credentials.
- Wildcard copies are one local batch write; generated profiles are persisted
  one target at a time.
- Existing unrelated map entries and credential fields are preserved.

## Testing

### Pure analyzer tests

Cover exact entries, universal and prefix wildcard matching, a wildcard stored
under an unrelated exact key, same-profile deduplication, distinct-profile
conflicts, targets not covered by the wildcard, unrelated preserved map
entries, repeated target bundle identifiers, malformed entries, and unresolved
target identifiers.

### Credential-source tests

Extend the existing export source-selection tests while extracting the helper.
Lock local-only, global-only, both-store ambiguity, explicit selectors,
mutually exclusive selectors, no explicit fallback, malformed selected files,
and unchanged export behavior.

### Command tests

Use injected filesystem, prompt, persistence, and Apple dependencies. Cover:

- missing Capacitor config, iOS project, Xcode project, targets, and concrete
  target identifiers;
- no iOS credentials, absent/empty/malformed map, and ad-hoc distribution;
- all targets already exact, with no prompt or `.p8` requirement;
- wildcard acceptance, wildcard decline, wildcard-only success without `.p8`,
  and distinct wildcard conflict;
- app-specific-password-only credentials, partial/invalid `.p8`, rejected Apple
  access, missing agreements, invalid P12/password, and unmatched Apple cert;
- bulk generation confirmation and cancellation;
- successful sequential generation and per-target persistence;
- duplicate replacement acceptance, decline, delete failure, and recreate
  failure;
- later-target failure followed by a rerun that skips saved entries;
- non-interactive prompt failure; and
- secret-free errors and summaries.

### Prescan and CLI wiring tests

Extend `cli/test/prescan/checks-ios-profiles.test.ts` for exact coverage,
wildcard-repair findings, distinct wildcard conflicts, and non-duplicated target
ownership. Cover present-but-empty and malformed maps so they cannot bypass the
fatal gate. Assert fatal severity and the exact public command text. Add CLI
help or registration coverage for `build credentials ios-provisioning` and its
two store flags.

## Verification

Run repository formatting/lint before validation, then run focused analyzer,
credential-export, command, prescan, and CLI-registration tests. Run
`bun run cli:check` as the full CLI gate when practical. Confirm the added
production implementation under `cli/src` does not exceed 1,100 lines; tests
and this specification are excluded from that count.
