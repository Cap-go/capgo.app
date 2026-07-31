---
name: native-builds
description: Use when working with Capgo Cloud native iOS and Android build requests, onboarding, credential storage, credential updates, and build output upload settings.
---

# Capgo CLI Native Builds

Use this skill for Capgo Cloud native iOS and Android build workflows.

## Onboarding (automated iOS setup)

### `build init` (alias: `build onboarding`)

- Interactive command that automates iOS certificate and provisioning profile creation.
- Reduces iOS setup from ~10 manual steps to 1 manual step (creating an API key) + 1 command.
- Example: `npx @capgo/cli@latest build init`
- Backward compatibility: `npx @capgo/cli@latest build onboarding` still works.
- Options:
  - `-a, --apikey <apikey>` — Capgo API key to authenticate with (alternative to the `CAPGO_TOKEN` env var or `~/.capgo` / local `.capgo` file). Takes precedence over a saved key when both are present. Lets the SaaS onboarding wizard render a single copy-pasteable command across bash, zsh, fish, PowerShell, and cmd.exe.
  - `--no-analytics` — Disable build onboarding analytics and terminal replay for this run.
  - Example: `npx @capgo/cli@latest build init -a cap_xxx`
- Notes:
  - Uses Ink (React for terminal) for the interactive UI, alongside the main `init` onboarding flow.
  - Requires running inside a Capacitor project directory with an `ios/` folder.
  - The user creates ONE App Store Connect API key (.p8 file), then the CLI handles everything else.
  - On macOS, offers a native file picker dialog for .p8 selection.
  - Auto-detects Key ID from .p8 filename (e.g. `AuthKey_XXXX.p8`).
  - Progress persists in `~/.capgo-credentials/onboarding/<appId>.json` — safe to interrupt and resume.
  - Saves credentials to the same `~/.capgo-credentials/credentials.json` used by `build request`.
  - Optionally kicks off the first build at the end.
  - If the native `ios/` folder is missing, onboarding can offer to run `cap add ios` automatically instead of exiting immediately.
  - Unexpected failures now keep the user inside the recovery screen, show package-manager-aware commands, and save a support bundle under `~/.capgo-credentials/support/`.
  - The recovery screen offers an "Email Capgo support" action: it writes a redacted diagnostics bundle as both `.log` and `.log.gz` under `~/.capgo-credentials/support/`, copies the `.log.gz` path to the clipboard, reveals it in Finder on macOS, and opens a pre-filled `mailto:support@capgo.app` for the user to attach the file and send (no logs are uploaded automatically). An "Ask AI for help" option is also offered when a build log exists.

#### What it automates (iOS)

1. Verifies the API key with Apple
2. Generates CSR + creates an `IOS_DISTRIBUTION` certificate via the App Store Connect API
3. Registers or reuses the bundle ID
4. Creates an `IOS_APP_STORE` provisioning profile
5. Saves all credentials (certificate as .p12, profile, API key, team ID)
6. Requests the first cloud build

#### Conflict resolution

- **Certificate limit reached**: lists existing certs, tags ones created by Capgo onboarding, lets the user pick one to revoke, then retries.
- **Duplicate provisioning profiles**: detects profiles matching the `Capgo <appId> AppStore` naming pattern, deletes them, and retries.
- **Existing credentials**: offers to backup existing credentials before proceeding, or exit onboarding.

#### Architecture

- `src/build/onboarding/command.ts` — entry point, launches Ink
- `src/build/onboarding/apple-api.ts` — JWT auth + App Store Connect API (verify, create cert, create profile, revoke, delete)
- `src/build/onboarding/csr.ts` — CSR generation + P12 creation via `node-forge`
- `src/build/onboarding/progress.ts` — per-app progress persistence
- `src/build/onboarding/file-picker.ts` — macOS native file picker via `osascript`
- `src/build/onboarding/ui/app.tsx` — Ink app (state machine)
- `src/build/onboarding/ui/components.tsx` — reusable UI components

#### BuildLogger callback interface

`requestBuildInternal` accepts an optional `BuildLogger` to receive log output via callbacks instead of writing directly to stdout. This enables clean integration with the Ink UI:

```typescript
interface BuildLogger {
  info: (msg: string) => void
  error: (msg: string) => void
  warn: (msg: string) => void
  success: (msg: string) => void
  buildLog: (msg: string) => void
  uploadProgress: (percent: number) => void
}
```

---

## Core build request

### `build needed [appId]`

- Example: `npx @capgo/cli@latest build needed com.example.app --channel production --verbose`
- Prints `yes` or `no` and exits with code `1` only when local native dependency metadata requires a new native build.
- If `--channel` is omitted, it uses `plugins.CapacitorUpdater.defaultChannel` from local config, then the public default channel in Capgo Cloud.
- Key options:
  - `-c, --channel <channel>`
  - `--verbose`
  - `--package-json <packageJson>`
  - `--node-modules <nodeModules>`

### `build request [appId]`

- Example: `npx @capgo/cli@latest build request com.example.app --platform ios --path .`
- Notes:
  - Zips the current project directory and uploads it to Capgo for building.
  - Builds are processed for store distribution.
  - Credentials are never stored permanently on Capgo servers.
  - Build outputs can be uploaded for time-limited download links.
  - Before requesting a build, save credentials with `build credentials save`.
- Core options:
  - `--path <path>`
  - `--node-modules <nodeModules>`: paths to `node_modules` directories for monorepos, comma-separated.
  - `--platform <platform>`: `ios` or `android`. If omitted in an interactive terminal, the CLI prompts for the platform; non-interactive runs must pass it explicitly.
  - `--build-mode <buildMode>`: `debug` or `release`.
  - `-a, --apikey <apikey>`
  - `--verbose`

#### iOS request options

- `--build-certificate-base64 <cert>`
- `--p12-password <password>`
- `--apple-id <email>`
- `--apple-app-specific-password <password>`
- `--apple-key-id <id>`
- `--apple-issuer-id <id>`
- `--apple-key-content <content>`
- `--app-store-connect-team-id <id>`
- `--ios-scheme <scheme>`
- `--ios-target <target>`
- `--ios-distribution <mode>`: `app_store` or `ad_hoc`
- `--ios-provisioning-profile <mapping>`: repeatable path or `bundleId=path`

#### Android request options

- `--android-keystore-file <keystore>`
- `--keystore-key-alias <alias>`
- `--keystore-key-password <password>`
- `--keystore-store-password <password>`
- `--play-config-json <json>`
- `--android-flavor <flavor>`
- `--in-app-update-priority <0-5>`: Google Play in-app update priority (higher = more urgent)

#### Output behavior options

- `--no-playstore-upload`: skip Play Store upload for the build, requires `--output-upload`
- `--submit-to-store-review`: submit after upload instead of leaving a draft/inactive store release. Android completes the Google Play release; iOS submits to TestFlight external review.
- `--store-release-name <name>`: Android Google Play version_name/release label.
- `--store-release-notes <notes>`: Google Play changelog and iOS TestFlight What to Test text.
- `--ios-testflight-groups <groups>`: comma-separated external TestFlight group names or IDs required with `--submit-to-store-review` on iOS.
- `--output-upload`
- `--no-output-upload`
- `--output-retention <duration>`: `1h` to `7d`
- `--skip-build-number-bump`
- `--no-skip-build-number-bump`

## Local credential management

Credentials are stored locally, either globally in `~/.capgo-credentials/credentials.json` or locally in `.capgo-credentials.json`.

### `build credentials save`

- Required before build requests.
- Supports global storage by default and local storage with `--local`.
- Example iOS flow:

```bash
npx @capgo/cli build credentials save --platform ios \
  --certificate ./cert.p12 --p12-password "password" \
  --ios-provisioning-profile ./profile.mobileprovision \
  --apple-key ./AuthKey.p8 --apple-key-id "KEY123" \
  --apple-issuer-id "issuer-uuid" --apple-team-id "team-id"
```

- Example multi-target iOS flow:

```bash
npx @capgo/cli build credentials save --platform ios \
  --ios-provisioning-profile ./App.mobileprovision \
  --ios-provisioning-profile com.example.widget=./Widget.mobileprovision
```

- Example Android flow:

```bash
npx @capgo/cli build credentials save --platform android \
  --keystore ./release.keystore --keystore-alias "my-key" \
  --keystore-key-password "key-pass" \
  --play-config ./service-account.json
```

- Core options:
  - `--appId <appId>`
  - `--platform <platform>`
  - `--local`
  - `--output-upload`, `--no-output-upload`
  - `--output-retention <duration>`
  - `--skip-build-number-bump`, `--no-skip-build-number-bump`

#### iOS credential save options

- `--certificate <path>`
- `--ios-provisioning-profile <mapping>`
- `--p12-password <password>`
- `--apple-key <path>`
- `--apple-key-id <id>`
- `--apple-issuer-id <id>`
- `--apple-team-id <id>`
- `--ios-distribution <mode>`
- `--apple-id <email>`
- `--apple-app-password <password>`

#### Android credential save options

- `--keystore <path>`
- `--keystore-alias <alias>`
- `--keystore-key-password <password>`
- `--keystore-store-password <password>`
- `--play-config <path>`
- `--android-flavor <flavor>`

### `build credentials list`

- Examples:
  - `npx @capgo/cli build credentials list`
  - `npx @capgo/cli build credentials list --appId com.example.app`
- Options:
  - `--appId <appId>`
  - `--local`

### `build credentials clear`

- Examples:
  - `npx @capgo/cli build credentials clear`
  - `npx @capgo/cli build credentials clear --local`
  - `npx @capgo/cli build credentials clear --appId com.example.app --platform ios`
- Options:
  - `--appId <appId>`
  - `--platform <platform>`
  - `--local`

### `build credentials update`

- Use to update specific credential fields without re-entering all data.
- Platform is auto-detected from the supplied options.
- Examples:
  - `npx @capgo/cli build credentials update --ios-provisioning-profile ./new-profile.mobileprovision`
  - `npx @capgo/cli build credentials update --local --keystore ./new-keystore.jks`
- Core options:
  - `--appId <appId>`
  - `--platform <platform>`
  - `--local`
  - `--overwrite-ios-provisioning-map`
  - `--output-upload`, `--no-output-upload`
  - `--output-retention <duration>`
  - `--skip-build-number-bump`, `--no-skip-build-number-bump`
- Supports the same iOS and Android credential fields as `build credentials save`.

### `build credentials migrate`

- Example: `npx @capgo/cli build credentials migrate --platform ios`
- Notes:
  - Converts `BUILD_PROVISION_PROFILE_BASE64` to `CAPGO_IOS_PROVISIONING_MAP`.
  - Discovers the main bundle ID from the Xcode project automatically.
- Options:
  - `--appId <appId>`
  - `--platform <platform>`: only `ios`
  - `--local`

## Supporting docs

- iOS setup: `https://capgo.app/docs/cli/cloud-build/ios/`
- Android setup: `https://capgo.app/docs/cli/cloud-build/android/`
