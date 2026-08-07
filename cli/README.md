# Capgo CLI
<a href="https://capgo.app/"><img src="https://capgo.app/readme-banner.svg?repo=Cap-go/capgo" alt="Capgo - Instant updates for Capacitor" /></a>
[![Discord](https://badgen.net/badge/icon/discord?icon=discord&label)](https://discord.com/invite/VnYRvBfgA6)
<a href="https://discord.com/invite/VnYRvBfgA6"><img src="https://img.shields.io/discord/912707985829163099?color=%237289DA&label=Discord" alt="Discord"></a>
[![npm](https://img.shields.io/npm/dm/@capgo/cli)](https://www.npmjs.com/package/@capgo/cli)
[![GitHub latest commit](https://badgen.net/github/last-commit/Cap-go/capgo/main)](https://github.com/Cap-go/capgo/commit/)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=bugs)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)

<div align="center">
  <h2><a href="https://capgo.app/?ref=cli_readme"> ➡️ Get Instant updates for your App with Capgo</a></h2>
  <h2><a href="https://capgo.app/consulting/?ref=cli_readme"> Missing a feature? We’ll build it for you 💪</a></h2>
</div>

Command line tool to manage Capgo apps, bundles, channels, compatibility checks,
and cloud builds from your terminal or CI.

Open-source CLI for Capacitor live updates.

## Why Capgo CLI?

Shipping live updates should not require clicking through a dashboard for every
release. Capgo CLI solves this by:

- **Fast setup** - Connect a Capacitor app to Capgo with one guided command
- **CI-ready uploads** - Build your app, upload the web bundle, and assign it to a channel
- **Compatibility checks** - Detect when a native release is required instead of an OTA update
- **Channel control** - Promote bundles through production, beta, QA, or custom release tracks
- **Cloud builds** - Save credentials locally and request iOS or Android builds from the CLI
- **Automation** - Use the SDK or MCP server for scripts, agents, and release tooling

Perfect for first-time setup, repeatable releases, native-vs-OTA decisions, and
teams that want Capgo controlled from CI.

## Features

- ☁️ Cloud / Self hosted Support: Use [Capgo Cloud](https://capgo.app/) or your own Supabase backend.
- 🚀 Guided Setup: Initialize a Capacitor app and verify live updates end to end.
- 📦 Bundle Management: Upload, list, delete, encrypt, decrypt, and clean bundles.
- 📺 Channel Support: Assign bundles to release channels and manage rollout tracks.
- 🧪 Compatibility: Check native package compatibility before shipping OTA updates.
- 🔁 **Delta Updates**: Upload changed files only when instant updates are enabled.
- 🔒 **Security**: Support signed and encrypted bundles for sensitive apps.
- 📱 Device Runner: Launch iOS or Android devices and simulators from the CLI.
- 🏗️ Cloud Builds: Request iOS and Android builds with locally stored credentials.
- 🤖 MCP + SDK: Automate Capgo from AI agents, Node.js, or TypeScript scripts.
- 🔋 Supports Android and iOS
- ⚡️ Capacitor 4/5/6/7/8 support through the Capgo updater ecosystem
- 🌐 **Open Source Backend**: Self install [our backend](https://github.com/Cap-go/capgo) in your infra

You have 3 ways possible:

- Use [capgo.app](https://capgo.app) for a full featured live-update system with setup, upload, channels, rollback, stats, and cloud builds.
- Use your own self-hosted backend with `--supa-host` and `--supa-anon` on supported commands.
- Use the CLI programmatically through the SDK or MCP server for custom release automation.

## Quick Start

Create your account in [capgo.app](https://capgo.app), get your [API key](https://console.capgo.app/dashboard/apikeys), and run:

```bash
npx @capgo/cli@latest init YOUR_API_KEY com.example.app
```

For an app that is already configured, upload a new bundle with:

```bash
npx @capgo/cli@latest bundle upload com.example.app --path ./dist --channel production
```

## CI Upload Example

```bash
npm ci
npm run build
npx @capgo/cli@latest bundle upload com.example.app \
  --apikey "$CAPGO_API_KEY" \
  --path ./dist \
  --channel production \
  --bundle "$GITHUB_SHA" \
  --version-exists-ok
```

Add `--fail-on-incompatible` when CI must stop instead of uploading a bundle that
cannot safely update the current native build.

## Documentation

The most complete [documentation is here](https://capgo.app/docs/).

- CLI guide: https://capgo.app/docs/cli/overview/
- Live updates setup: https://capgo.app/docs/plugin/cloud-mode/getting-started/
- Cloud build guides: https://capgo.app/docs/cli/cloud-build/ios/ and https://capgo.app/docs/cli/cloud-build/android/

## Community

Join the [discord](https://discord.gg/VnYRvBfgA6) to get help.


## Dynamic monorepos

When a root `capacitor.config.ts` selects an app-specific source through an environment variable, keep that selector active and pass the source to Capgo:

```bash
CAP_APP=qr-code-reader npx @capgo/cli@latest init \
  --package-json ./package.json \
  --main-file ./projects/qr-code-reader/src/main.ts \
  --capacitor-config ./env-configs/capacitor.config.qr-code-reader.ts
```

Capgo continues to load the root config while writing only the selected source. Use `--capacitor-config` on every config-changing CLI command, or the matching `capacitorConfig` SDK/MCP option.
<!-- AUTO-GENERATED-DOCS-START -->
## 📑 Capgo CLI Commands

## 📋 Table of Contents

- 🚀 [Init](#init)
- 📱 [Run](#run)
  - [Device](#run-device)
- 🔹 [Star](#star)
- 🔹 [Star-all](#star-all)
- 👨‍⚕️ [Doctor](#doctor)
- 🔑 [Login](#login)
- 🔹 [Get-qr](#get-qr)
- 📦 [Bundle](#bundle)
  - [Upload](#bundle-upload)
  - [Compatibility](#bundle-compatibility)
  - [ReleaseType](#bundle-releaseType)
  - [Delete](#bundle-delete)
  - [List](#bundle-list)
  - [Cleanup](#bundle-cleanup)
  - [Encrypt](#bundle-encrypt)
  - [Decrypt](#bundle-decrypt)
  - [Zip](#bundle-zip)
- 📱 [App](#app)
  - [Add](#app-add)
  - [Delete](#app-delete)
  - [List](#app-list)
  - [Debug](#app-debug)
  - [Setting](#app-setting)
  - [Set](#app-set)
- 📢 [Channel](#channel)
  - [Add](#channel-add)
  - [Delete](#channel-delete)
  - [List](#channel-list)
  - [CurrentBundle](#channel-currentBundle)
  - [Set](#channel-set)
- 🔐 [Key](#key)
  - [Save](#key-save)
  - [Create](#key-create)
  - [Delete_old](#key-delete_old)
- 👤 [Account](#account)
  - [Id](#account-id)
- 🔹 [Organization](#organization)
  - [List](#organization-list)
  - [Add](#organization-add)
  - [Members](#organization-members)
  - [Set](#organization-set)
  - [Delete](#organization-delete)
- 🔹 [Organisation](#organisation)
  - [List](#organisation-list)
  - [Add](#organisation-add)
  - [Set](#organisation-set)
  - [Delete](#organisation-delete)
- 🔹 [Build](#build)
  - [Needed](#build-needed)
  - [Init](#build-init)
  - [Request](#build-request)
  - [Sync-ios-version](#build-sync-ios-version)
  - [Prescan](#build-prescan)
  - [Last-output](#build-last-output)
  - [Credentials](#build-credentials)
    - [Apple-key](#build-credentials-apple-key)
    - [Save](#build-credentials-save)
    - [List](#build-credentials-list)
    - [Clear](#build-credentials-clear)
    - [Update](#build-credentials-update)
    - [Manage](#build-credentials-manage)
    - [Migrate](#build-credentials-migrate)
- 🔹 [Notifications](#notifications)
  - [Setup](#notifications-setup)
- 🔹 [Probe](#probe)
- 🔹 [Generate-docs](#generate-docs)
- 🔹 [Mcp](#mcp)

## <a id="init"></a> 🚀 **Init**

**Alias:** `i`

```bash
npx @capgo/cli@latest init
```

🚀 Initialize a new app in Capgo Cloud with step-by-step guidance.
This includes adding code for updates, building, uploading your app, and verifying update functionality.
Capgo bundles are web assets and can be fetched by anyone who knows the URL. Use encryption for banking, regulated, or other high-security apps.
During the iOS run-on-device step, choose a physical iPhone/iPad or simulator. If you choose a physical device, the CLI lets you connect, unlock, and check again before it launches the app.

**Example:**

```bash
npx @capgo/cli@latest init YOUR_API_KEY com.example.app
```

## <a id="options-init"></a> Options (Init)

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-n** | <code>string</code> | App name for display in Capgo Cloud |
| **-i** | <code>string</code> | App icon path for display in Capgo Cloud |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |
| **--package-json** | <code>string</code> | Package JSON for the Capacitor app to onboard (useful in monorepos) |
| **--main-file** | <code>string</code> | Application entry file to update (useful in monorepos) |
| **--capacitor-config** | <code>string</code> | Capacitor config source to update (useful with dynamic monorepo configs) |
| **--no-analytics** | <code>boolean</code> | Disable init analytics and terminal replay for this run |


## <a id="run"></a> 📱 **Run**

📱 Run Capacitor apps on devices from the CLI.

### <a id="run-device"></a> 🔹 **Device**

```bash
npx @capgo/cli@latest run device
```

📱 Run your Capacitor app on a connected device or simulator.
If you omit the platform in an interactive terminal, the command asks whether to start on iOS or Android.
The command lists available devices and simulators, lets you reload the list, and runs with your selection.
For iOS, this asks whether to use a physical iPhone/iPad or simulator before showing devices.
Use --no-launch to print the resolved command without starting the app.

**Example:**

```bash
npx @capgo/cli@latest run device ios --no-launch
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--no-launch** | <code>boolean</code> | Resolve and print the run command without starting the app |


## <a id="star"></a> 🔹 **Star**

```bash
npx @capgo/cli@latest star
```

⭐ Star a Capgo GitHub repository to support the project.
If you do not pass a repository name, this defaults to capacitor-updater in the Cap-go org.


## <a id="star-all"></a> 🔹 **Star-all**

```bash
npx @capgo/cli@latest star-all
```

⭐ Star all Capgo GitHub repositories with a small random delay between each request.
If you do not pass repositories, this defaults to all Cap-go repositories whose name starts with `capacitor-`.

## <a id="options-star-all"></a> Options (Star-all)

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--min-delay-ms** | <code>string</code> | Minimum delay in ms between each star action (default: 20) |
| **--max-delay-ms** | <code>string</code> | Maximum delay in ms between each star action (default: 180) |
| **--max-concurrency** | <code>string</code> | Maximum number of star requests running in parallel (default: 4) |


## <a id="doctor"></a> 👨‍⚕️ **Doctor**

```bash
npx @capgo/cli@latest doctor
```

👨‍⚕️ Check if your Capgo app installation is up-to-date and gather information useful for bug reports.
This command helps diagnose issues with your setup.

**Example:**

```bash
npx @capgo/cli@latest doctor
```

## <a id="options-doctor"></a> Options (Doctor)

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |


## <a id="login"></a> 🔑 **Login**

**Alias:** `l`

```bash
npx @capgo/cli@latest login
```

🔑 Save your Capgo API key to your machine or local folder for easier access to Capgo Cloud services.
Use --apikey=******** in any command to override it.

**Example:**

```bash
npx @capgo/cli@latest login YOUR_API_KEY
```

## <a id="options-login"></a> Options (Login)

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--local** | <code>boolean</code> | Only save in local folder, git ignored for security. |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |


## <a id="get-qr"></a> 🔹 **Get-qr**

```bash
npx @capgo/cli@latest get-qr
```

🔳 Print a terminal QR code for a bundle or channel preview.
Preview must be enabled for the app.
Examples:
  npx @capgo/cli@latest get-qr com.example.app --bundle 1.2.3
  npx @capgo/cli@latest get-qr com.example.app --bundle 123
  npx @capgo/cli@latest get-qr com.example.app --channel production
  npx @capgo/cli@latest get-qr com.example.app production --type channel

## <a id="options-get-qr"></a> Options (Get-qr)

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--bundle** | <code>string</code> | Bundle name or id to preview |
| **--channel** | <code>string</code> | Channel name or id to preview |
| **--type** | <code>string</code> | Type for positional target |
| **--png** | <code>string</code> | Write the preview QR code as a PNG image to the given file path |
| **--url** | <code>boolean</code> | Print preview URLs only (web and deep link), without a terminal QR code |
| **--web-url** | <code>boolean</code> | Encode the web preview URL in the QR code and PNG instead of the capgo:// deep link |
| **--preview-env** | <code>string</code> | Preview web URL environment |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |


## <a id="bundle"></a> 📦 **Bundle**

📦 Manage app bundles for deployment in Capgo Cloud, including upload, compatibility checks, and encryption.

### <a id="bundle-upload"></a> ⬆️ **Upload**

**Alias:** `u`

```bash
npx @capgo/cli@latest bundle upload
```

⬆️ Upload a new app bundle to Capgo Cloud for distribution.
Version must be > 0.0.0 and unique. Deleted versions cannot be reused for security.
External option: Store only a URL link (useful for apps >200MB or privacy requirements).
Capgo never inspects external content. Add encryption for trustless security.

**Example:**

```bash
npx @capgo/cli@latest bundle upload com.example.app --path ./dist --channel production,beta
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **-p** | <code>string</code> | Path of the folder to upload, if not provided it will use the webDir set in capacitor.config |
| **-c** | <code>string</code> | Channel to link to. Use commas for multiple channels, for example production,beta |
| **--rollout** | <code>string</code> | Set the uploaded bundle as this channel's rollout target at a percentage from 0 to 100 |
| **--rollout-percentage-bps** | <code>string</code> | Set the uploaded bundle rollout percentage in basis points from 0 to 10000 |
| **--rollout-cache-ttl-seconds** | <code>string</code> | Cloudflare rollout decision cache TTL in seconds |
| **-e** | <code>string</code> | Link to external URL instead of upload to Capgo Cloud |
| **--iv-session-key** | <code>string</code> | Set the IV and session key for bundle URL external |
| **--s3-region** | <code>string</code> | Region for your S3 bucket |
| **--s3-apikey** | <code>string</code> | API key for your S3 endpoint |
| **--s3-apisecret** | <code>string</code> | API secret for your S3 endpoint |
| **--s3-endpoint** | <code>string</code> | URL of S3 endpoint |
| **--s3-bucket-name** | <code>string</code> | Name for your AWS S3 bucket |
| **--s3-port** | <code>string</code> | Port for your S3 endpoint |
| **--no-s3-ssl** | <code>boolean</code> | Disable SSL for S3 upload |
| **--key-v2** | <code>string</code> | Custom path for private signing key (v2 system) |
| **--key-data-v2** | <code>string</code> | Private signing key (v2 system) |
| **--bundle-url** | <code>boolean</code> | Prints bundle URL into stdout |
| **--no-key** | <code>boolean</code> | Ignore signing key and send clear update |
| **--no-code-check** | <code>boolean</code> | Ignore checking if notifyAppReady() is called in source code and index present in root folder |
| **--display-iv-session** | <code>boolean</code> | Show in the console the IV and session key used to encrypt the update |
| **-b** | <code>string</code> | Bundle version number of the bundle to upload |
| **--link** | <code>string</code> | Link to external resource (e.g. GitHub release) |
| **--comment** | <code>string</code> | Comment about this version, could be a release note, a commit hash, a commit message, etc. |
| **--min-update-version** | <code>string</code> | Minimal version required to update to this version. Used only if the disable auto update is set to metadata in channel |
| **--auto-min-update-version** | <code>boolean</code> | Set the min update version based on native packages |
| **--ignore-metadata-check** | <code>boolean</code> | Ignores the metadata (node_modules) check when uploading |
| **--fail-on-incompatible** | <code>boolean</code> | Fail the upload (exit non-zero) instead of uploading when the bundle is incompatible with the channel's current native packages. In an interactive terminal you can still choose a native build; declining fails. Cannot be combined with --ignore-metadata-check. |
| **--ignore-checksum-check** | <code>boolean</code> | Ignores the checksum check when uploading |
| **--force-crc32-checksum** | <code>boolean</code> | Force CRC32 checksum for upload (override auto-detection) |
| **--timeout** | <code>string</code> | Timeout for the upload process in seconds |
| **--multipart** | <code>boolean</code> | [DEPRECATED] Use --tus instead. Uses multipart protocol for S3 uploads |
| **--zip** | <code>boolean</code> | Upload the bundle using zip to Capgo cloud (legacy) |
| **--tus** | <code>boolean</code> | Upload the bundle using TUS to Capgo cloud |
| **--tus-chunk-size** | <code>string</code> | Chunk size in bytes for TUS resumable uploads (default: auto) |
| **--partial** | <code>boolean</code> | [DEPRECATED] Use --delta instead. Upload incremental updates |
| **--partial-only** | <code>boolean</code> | [DEPRECATED] Use --delta-only instead. Upload only incremental updates, skip full bundle |
| **--delta** | <code>boolean</code> | Upload delta updates (only changed files) for instant, super-fast updates instead of big zip downloads. Capgo refuses delta uploads over 10,000 files (delta tracks each file); use --no-delta for a full zip, or reduce files in your web build. |
| **--delta-only** | <code>boolean</code> | Upload only delta updates without full bundle for maximum speed (useful for large apps) |
| **--no-delta** | <code>boolean</code> | Disable delta updates even if instant updates are enabled |
| **--encrypted-checksum** | <code>string</code> | An encrypted checksum (signature). Used only when uploading an external bundle. |
| **--auto-set-bundle** | <code>boolean</code> | Set the bundle version in Capacitor config |
| **--capacitor-config** | <code>string</code> | Capacitor config source to update (useful with dynamic monorepo configs) |
| **--dry-upload** | <code>boolean</code> | Dry upload the bundle process: add the row in database without uploading files or updating channels (Used by Capgo for internal testing) |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |
| **--node-modules** | <code>string</code> | Paths to node_modules directories for monorepos (comma-separated) |
| **--encrypt-partial** | <code>boolean</code> | Encrypt delta update files (auto-enabled for updater > 6.14.4) |
| **--delete-linked-bundle-on-upload** | <code>boolean</code> | Locates the currently linked bundle in the channel you are trying to upload to, and deletes it |
| **--no-brotli-patterns** | <code>string</code> | Files to exclude from Brotli compression (comma-separated globs, e.g., "*.jpg,*.png") |
| **--disable-brotli** | <code>boolean</code> | Completely disable brotli compression even if updater version supports it |
| **--version-exists-ok** | <code>boolean</code> | Exit successfully if bundle version already exists, useful for CI/CD workflows with monorepos |
| **--self-assign** | <code>boolean</code> | Allow devices to auto-join this channel (updates channel setting) |
| **--qr-preview** | <code>boolean</code> | Print a terminal QR code for this bundle preview after upload |
| **--send-update-notification** | <code>boolean</code> | Send a native update-check notification to devices after updating linked channel bundles |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |
| **--verbose** | <code>boolean</code> | Enable verbose output with detailed logging |

### <a id="bundle-compatibility"></a> 🧪 **Compatibility**

```bash
npx @capgo/cli@latest bundle compatibility
```

🧪 Check compatibility of a bundle with a specific channel in Capgo Cloud to ensure updates are safe.

**Example:**

```bash
npx @capgo/cli@latest bundle compatibility com.example.app --channel production
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **-c** | <code>string</code> | Channel to check the compatibility with |
| **--text** | <code>boolean</code> | Output text instead of emojis |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |
| **--node-modules** | <code>string</code> | Paths to node_modules directories for monorepos (comma-separated) |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="bundle-releaseType"></a> 🔹 **ReleaseType**

```bash
npx @capgo/cli@latest bundle releaseType
```

🧭 Print "native" or "OTA" based on compatibility with a channel's latest metadata.

**Example:**

```bash
npx @capgo/cli@latest bundle releaseType com.example.app --channel production
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **-c** | <code>string</code> | Channel to compare against |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |
| **--node-modules** | <code>string</code> | Paths to node_modules directories for monorepos (comma-separated) |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="bundle-delete"></a> 🗑️ **Delete**

**Alias:** `d`

```bash
npx @capgo/cli@latest bundle delete
```

🗑️ Delete a specific bundle from Capgo Cloud, optionally targeting a single version.

**Example:**

```bash
npx @capgo/cli@latest bundle delete BUNDLE_ID com.example.app
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="bundle-list"></a> 📋 **List**

**Alias:** `l`

```bash
npx @capgo/cli@latest bundle list
```

📋 List all bundles uploaded for an app in Capgo Cloud.

**Example:**

```bash
npx @capgo/cli@latest bundle list com.example.app
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="bundle-cleanup"></a> 🧹 **Cleanup**

**Alias:** `c`

```bash
npx @capgo/cli@latest bundle cleanup
```

🧹 Delete old bundles in Capgo Cloud, keeping specified number of recent versions.
Bundles linked to channels are preserved unless --ignore-channel is used.

**Example:**

```bash
npx @capgo/cli@latest bundle cleanup com.example.app --bundle=1.0 --keep=3
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-b** | <code>string</code> | Bundle version number of the app to delete |
| **-a** | <code>string</code> | API key to link to your account |
| **-k** | <code>string</code> | Number of versions to keep |
| **-f** | <code>boolean</code> | Force removal |
| **--ignore-channel** | <code>boolean</code> | Delete bundles even if linked to channels (WARNING: deletes channels too) |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="bundle-encrypt"></a> 🔒 **Encrypt**

```bash
npx @capgo/cli@latest bundle encrypt
```

🔒 Encrypt a zip bundle for secure external storage.
Returns ivSessionKey for upload/decryption. Get checksum using 'bundle zip --json'.

**Example:**

```bash
npx @capgo/cli@latest bundle encrypt ./myapp.zip CHECKSUM
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--key** | <code>string</code> | Custom path for private signing key |
| **--key-data** | <code>string</code> | Private signing key |
| **-j** | <code>boolean</code> | Output in JSON |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |

### <a id="bundle-decrypt"></a> 🔓 **Decrypt**

```bash
npx @capgo/cli@latest bundle decrypt
```

🔓 Decrypt an encrypted bundle (mainly for testing).
Prints base64 session key for verification.

**Example:**

```bash
npx @capgo/cli@latest bundle decrypt ./myapp_encrypted.zip CHECKSUM
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--key** | <code>string</code> | Custom path for private signing key |
| **--key-data** | <code>string</code> | Private signing key |
| **--checksum** | <code>string</code> | Checksum of the bundle, to verify the integrity of the bundle |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |

### <a id="bundle-zip"></a> 🔹 **Zip**

```bash
npx @capgo/cli@latest bundle zip
```

🗜️ Create a zip file of your app bundle.
Returns checksum for use with encryption. Use --json for machine-readable output.

**Example:**

```bash
npx @capgo/cli@latest bundle zip com.example.app --path ./dist
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-p** | <code>string</code> | Path of the folder to upload, if not provided it will use the webDir set in capacitor.config |
| **-b** | <code>string</code> | Bundle version number to name the zip file |
| **-n** | <code>string</code> | Name of the zip file |
| **-j** | <code>boolean</code> | Output in JSON |
| **--no-code-check** | <code>boolean</code> | Ignore checking if notifyAppReady() is called in source code and index present in root folder |
| **--key-v2** | <code>boolean</code> | Use encryption v2 |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |


## <a id="app"></a> 📱 **App**

📱 Manage your Capgo app settings and configurations in Capgo Cloud.

### <a id="app-add"></a> ➕ **Add**

**Alias:** `a`

```bash
npx @capgo/cli@latest app add
```

➕ Add a new app to Capgo Cloud with a unique app ID in the format com.test.app.
All options can be guessed from config if not provided.

**Example:**

```bash
npx @capgo/cli@latest app add com.example.app --name "My App" --icon ./icon.png
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-n** | <code>string</code> | App name for display in Capgo Cloud |
| **-i** | <code>string</code> | App icon path for display in Capgo Cloud |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="app-delete"></a> 🗑️ **Delete**

```bash
npx @capgo/cli@latest app delete
```

🗑️ Delete an app from Capgo Cloud, optionally specifying a version to delete only that bundle.

**Example:**

```bash
npx @capgo/cli@latest app delete com.example.app
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="app-list"></a> 📋 **List**

**Alias:** `l`

```bash
npx @capgo/cli@latest app list
```

📋 List all apps registered under your account in Capgo Cloud.

**Example:**

```bash
npx @capgo/cli@latest app list
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="app-debug"></a> 🐞 **Debug**

```bash
npx @capgo/cli@latest app debug
```

🐞 Listen for live update events in Capgo Cloud to debug your app.
Optionally target a specific device for detailed diagnostics.

**Example:**

```bash
npx @capgo/cli@latest app debug com.example.app --device DEVICE_ID
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **-d** | <code>string</code> | The specific device ID to debug |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="app-setting"></a> ⚙️ **Setting**

```bash
npx @capgo/cli@latest app setting
```

⚙️ Modify Capacitor configuration programmatically.
Specify setting path (e.g., plugins.CapacitorUpdater.defaultChannel) with --string or --bool.

**Example:**

```bash
npx @capgo/cli@latest app setting plugins.CapacitorUpdater.defaultChannel --string "Production"
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--bool** | <code>string</code> | A value for the setting to modify as a boolean, ex: --bool true |
| **--string** | <code>string</code> | A value for the setting to modify as a string, ex: --string "Production" |
| **--capacitor-config** | <code>string</code> | Capacitor config source to update (useful with dynamic monorepo configs) |

### <a id="app-set"></a> ⚙️ **Set**

**Alias:** `s`

```bash
npx @capgo/cli@latest app set
```

⚙️ Update settings for an existing app in Capgo Cloud, such as name, icon, or retention period for bundles.
Retention of 0 means infinite storage.

**Example:**

```bash
npx @capgo/cli@latest app set com.example.app --name "Updated App" --retention 30
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-n** | <code>string</code> | App name for display in Capgo Cloud |
| **-i** | <code>string</code> | Local image file path (png, jpg, webp, svg) used as the app icon in Capgo Cloud |
| **-a** | <code>string</code> | API key to link to your account |
| **-r** | <code>string</code> | Days to keep old bundles (0 = infinite, default: 0) |
| **--expose-metadata** | <code>string</code> | Expose bundle metadata (link and comment) to the plugin (true/false, default: false) |
| **--preview** | <code>boolean</code> | Enable bundle and channel preview QR codes for this app |
| **--no-preview** | <code>boolean</code> | Disable bundle and channel preview QR codes for this app |
| **--allow-device-custom-id** | <code>boolean</code> | Allow devices to set a custom device ID for this app |
| **--no-allow-device-custom-id** | <code>boolean</code> | Disallow custom device IDs for this app |
| **--block-provider-infra-requests** | <code>boolean</code> | Block provider infrastructure requests for this app |
| **--no-block-provider-infra-requests** | <code>boolean</code> | Allow provider infrastructure requests for this app |
| **--build-timeout-minutes** | <code>string</code> | Native build timeout in minutes (5-360, default: 15) |
| **--ios-store-url** | <code>string</code> | iOS App Store URL for this app |
| **--android-store-url** | <code>string</code> | Google Play Store URL for this app |
| **--default-upload-channel** | <code>string</code> | Default upload channel name for this app |
| **--default-download-channel** | <code>string</code> | Default download channel name for this app (sets channel public=true) |
| **--disable-download-channels** | <code>boolean</code> | Disable Capgo download channels for this app (sets all channels public=false) |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |


## <a id="channel"></a> 📢 **Channel**

📢 Manage distribution channels for app updates in Capgo Cloud, controlling how updates are delivered to devices.

### <a id="channel-add"></a> ➕ **Add**

**Alias:** `a`

```bash
npx @capgo/cli@latest channel add
```

➕ Create a new channel for app distribution in Capgo Cloud to manage update delivery.

**Example:**

```bash
npx @capgo/cli@latest channel add production com.example.app --default
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-d** | <code>boolean</code> | Set the channel as default |
| **--self-assign** | <code>boolean</code> | Allow device to self-assign to this channel |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="channel-delete"></a> 🗑️ **Delete**

**Alias:** `d`

```bash
npx @capgo/cli@latest channel delete
```

🗑️ Delete a channel from Capgo Cloud, optionally removing associated bundles to free up resources.

**Example:**

```bash
npx @capgo/cli@latest channel delete production com.example.app
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--delete-bundle** | <code>boolean</code> | Delete the bundle associated with the channel |
| **--success-if-not-found** | <code>boolean</code> | Success if the channel is not found |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="channel-list"></a> 📋 **List**

**Alias:** `l`

```bash
npx @capgo/cli@latest channel list
```

📋 List all channels configured for an app in Capgo Cloud to review distribution settings.

**Example:**

```bash
npx @capgo/cli@latest channel list com.example.app
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="channel-currentBundle"></a> 📦 **CurrentBundle**

```bash
npx @capgo/cli@latest channel currentBundle
```

📦 Get the current bundle linked to a specific channel in Capgo Cloud for update tracking.

**Example:**

```bash
npx @capgo/cli@latest channel currentBundle production com.example.app
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-c** | <code>string</code> | Channel to get the current bundle from |
| **-a** | <code>string</code> | API key to link to your account |
| **--quiet** | <code>boolean</code> | Only print the bundle version |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="channel-set"></a> ⚙️ **Set**

**Alias:** `s`

```bash
npx @capgo/cli@latest channel set
```

⚙️ Configure settings for a channel, such as linking a bundle, setting update strategies (major, minor, metadata, patch, none), or device targeting (iOS, Android, dev, prod, emulator, device).
One channel must be default.

**Example:**

```bash
npx @capgo/cli@latest channel set production com.example.app --bundle 1.0.0 --state default
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **-b** | <code>string</code> | Bundle version number of the file to set |
| **-s** | <code>string</code> | Set the state of the channel, default or normal |
| **--latest-remote** | <code>boolean</code> | Get the latest bundle uploaded in capgo cloud and set it to the channel |
| **--latest** | <code>boolean</code> | Get the latest version key in the package.json to set it to the channel |
| **--downgrade** | <code>boolean</code> | Allow to downgrade to version under native one |
| **--no-downgrade** | <code>boolean</code> | Disable downgrade to version under native one |
| **--ios** | <code>boolean</code> | Allow sending update to iOS devices |
| **--no-ios** | <code>boolean</code> | Disable sending update to iOS devices |
| **--android** | <code>boolean</code> | Allow sending update to Android devices |
| **--no-android** | <code>boolean</code> | Disable sending update to Android devices |
| **--self-assign** | <code>boolean</code> | Allow device to self-assign to this channel |
| **--no-self-assign** | <code>boolean</code> | Disable devices to self-assign to this channel |
| **--disable-auto-update** | <code>string</code> | Block updates by type: major, minor, metadata, patch, or none (allows all) |
| **--rollout-bundle** | <code>string</code> | Bundle version to release gradually on this channel |
| **--rollout-percentage** | <code>string</code> | Rollout percentage from 0 to 100 |
| **--rollout-percentage-bps** | <code>string</code> | Rollout percentage in basis points from 0 to 10000 |
| **--rollout-enable** | <code>boolean</code> | Enable the configured rollout |
| **--rollout-disable** | <code>boolean</code> | Disable the configured rollout and unlink the rollout bundle |
| **--rollout-pause** | <code>boolean</code> | Pause rollout exposure without rolling back selected devices |
| **--rollout-resume** | <code>boolean</code> | Resume a paused rollout |
| **--rollout-rollback** | <code>boolean</code> | Clear rollout state and return devices to stable |
| **--rollout-promote** | <code>boolean</code> | Promote rollout target to stable and clear rollout state |
| **--rollout-cache-ttl-seconds** | <code>string</code> | Cloudflare rollout decision cache TTL in seconds |
| **--auto-pause-enabled** | <code>boolean</code> | Enable rollout auto-pause policy |
| **--auto-pause-disabled** | <code>boolean</code> | Disable rollout auto-pause policy |
| **--auto-pause-window-minutes** | <code>string</code> | Stats window for rollout auto-pause |
| **--auto-pause-failure-rate-bps** | <code>string</code> | Failure-rate threshold in basis points |
| **--auto-pause-confidence** | <code>string</code> | Confidence level between 0 and 1 |
| **--auto-pause-min-attempts** | <code>string</code> | Minimum install plus fail attempts before auto-pause can trigger |
| **--auto-pause-min-failures** | <code>string</code> | Minimum failures before auto-pause can trigger |
| **--auto-pause-action** | <code>string</code> | Auto-pause action: pause, rollback, or notify |
| **--auto-pause-cooldown-minutes** | <code>string</code> | Cooldown before auto-pause can trigger again |
| **--dev** | <code>boolean</code> | Allow sending update to development devices |
| **--no-dev** | <code>boolean</code> | Disable sending update to development devices |
| **--prod** | <code>boolean</code> | Allow sending update to production devices |
| **--no-prod** | <code>boolean</code> | Disable sending update to production devices |
| **--emulator** | <code>boolean</code> | Allow sending update to emulator devices |
| **--no-emulator** | <code>boolean</code> | Disable sending update to emulator devices |
| **--device** | <code>boolean</code> | Allow sending update to physical devices |
| **--no-device** | <code>boolean</code> | Disable sending update to physical devices |
| **--qr-preview** | <code>boolean</code> | Print a terminal QR code for this channel preview after updating it |
| **--send-update-notification** | <code>boolean</code> | Send a native update-check notification to devices after updating the linked channel bundle |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |
| **--ignore-metadata-check** | <code>boolean</code> | Ignore checking node_modules compatibility if present in the bundle |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |


## <a id="key"></a> 🔐 **Key**

🔐 Manage encryption keys for secure bundle distribution in Capgo Cloud, supporting end-to-end encryption with RSA and AES combination.

### <a id="key-save"></a> 🔹 **Save**

```bash
npx @capgo/cli@latest key save
```

💾 Save the public key in the Capacitor config, useful for CI environments.
Recommended not to commit the key for security.

**Example:**

```bash
npx @capgo/cli@latest key save --key ./path/to/key.pub
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-f** | <code>boolean</code> | Force generate a new one |
| **--key** | <code>string</code> | Key path to save in Capacitor config |
| **--key-data** | <code>string</code> | Key data to save in Capacitor config |
| **--capacitor-config** | <code>string</code> | Capacitor config source to update (useful with dynamic monorepo configs) |

### <a id="key-create"></a> 🔨 **Create**

```bash
npx @capgo/cli@latest key create
```

🔨 Create RSA key pair for end-to-end encryption.
Creates .capgo_key_v2 (private) and .capgo_key_v2.pub (public) in project root.
Public key is saved to capacitor.config for mobile app decryption.
NEVER commit the private key - store it securely!

**Example:**

```bash
npx @capgo/cli@latest key create
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-f** | <code>boolean</code> | Force generate a new one |
| **--capacitor-config** | <code>string</code> | Capacitor config source to update (useful with dynamic monorepo configs) |

### <a id="key-delete_old"></a> 🗑️ **Delete_old**

```bash
npx @capgo/cli@latest key delete_old
```

🧹 Delete the old encryption key from the Capacitor config to ensure only the current key is used.

**Example:**

```bash
npx @capgo/cli@latest key delete_old
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--capacitor-config** | <code>string</code> | Capacitor config source to update (useful with dynamic monorepo configs) |


## <a id="account"></a> 👤 **Account**

👤 Manage your Capgo account details and retrieve information for support or collaboration.

### <a id="account-id"></a> 🔹 **Id**

```bash
npx @capgo/cli@latest account id
```

🪪 Retrieve your account ID, safe to share for collaboration or support purposes in Discord or other platforms.

**Example:**

```bash
npx @capgo/cli@latest account id
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |


## <a id="organization"></a> 🔹 **Organization**

🏢 Manage your organizations in Capgo Cloud for team collaboration and app management.

### <a id="organization-list"></a> 📋 **List**

**Alias:** `l`

```bash
npx @capgo/cli@latest organization list
```

📋 List all organizations you have access to in Capgo Cloud.

**Example:**

```bash
npx @capgo/cli@latest organization list
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="organization-add"></a> ➕ **Add**

**Alias:** `a`

```bash
npx @capgo/cli@latest organization add
```

➕ Create a new organization in Capgo Cloud for team collaboration.

**Example:**

```bash
npx @capgo/cli@latest organization add --name "My Company" --email admin@mycompany.com
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-n** | <code>string</code> | Organization name |
| **-e** | <code>string</code> | Management email for the organization |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="organization-members"></a> 🔹 **Members**

**Alias:** `m`

```bash
npx @capgo/cli@latest organization members
```

👥 List organization members and their 2FA status.
Shows all members of an organization with their roles and whether they have 2FA enabled.
Useful before enabling 2FA enforcement to see which members will be affected.
> ℹ️ Viewing 2FA status requires super_admin rights in the organization.


**Example:**

```bash
npx @capgo/cli@latest organization members ORG_ID
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="organization-set"></a> ⚙️ **Set**

**Alias:** `s`

```bash
npx @capgo/cli@latest organization set
```

⚙️ Update organization settings including name, email, security policies, and enforcement options.
Security settings require super_admin role.

**Example:**

```bash
npx @capgo/cli@latest organization set ORG_ID --name "New Name"
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-n** | <code>string</code> | Organization name |
| **-e** | <code>string</code> | Management email for the organization |
| **--enforce-2fa** | <code>boolean</code> | Enable 2FA enforcement for all organization members |
| **--no-enforce-2fa** | <code>boolean</code> | Disable 2FA enforcement for organization |
| **--password-policy** | <code>boolean</code> | Enable password policy enforcement for organization |
| **--no-password-policy** | <code>boolean</code> | Disable password policy enforcement |
| **--min-length** | <code>string</code> | Minimum password length (6-128, default: 10) |
| **--require-uppercase** | <code>boolean</code> | Require uppercase letter in password |
| **--no-require-uppercase** | <code>boolean</code> | Do not require uppercase letter |
| **--require-number** | <code>boolean</code> | Require number in password |
| **--no-require-number** | <code>boolean</code> | Do not require number |
| **--require-special** | <code>boolean</code> | Require special character in password |
| **--no-require-special** | <code>boolean</code> | Do not require special character |
| **--require-apikey-expiration** | <code>boolean</code> | Require all API keys to have an expiration date |
| **--no-require-apikey-expiration** | <code>boolean</code> | Do not require API key expiration |
| **--max-apikey-expiration-days** | <code>string</code> | Maximum days before API key expiration (1-365, null for no limit) |
| **--enforce-hashed-api-keys** | <code>boolean</code> | Enforce hashed/secure API keys (key value stored as hash, shown only once) |
| **--no-enforce-hashed-api-keys** | <code>boolean</code> | Allow plain-text API keys |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="organization-delete"></a> 🗑️ **Delete**

**Alias:** `d`

```bash
npx @capgo/cli@latest organization delete
```

🗑️ Delete an organization from Capgo Cloud. This action cannot be undone.
Only organization owners can delete organizations.

**Example:**

```bash
npx @capgo/cli@latest organization delete ORG_ID
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |


## <a id="organisation"></a> 🔹 **Organisation**

[DEPRECATED] Use "organization" instead. This command will be removed in a future version.

### <a id="organisation-list"></a> 📋 **List**

**Alias:** `l`

```bash
npx @capgo/cli@latest organisation list
```

[DEPRECATED] Use "organization list" instead.

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="organisation-add"></a> ➕ **Add**

**Alias:** `a`

```bash
npx @capgo/cli@latest organisation add
```

[DEPRECATED] Use "organization add" instead.

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-n** | <code>string</code> | Organization name |
| **-e** | <code>string</code> | Management email for the organization |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="organisation-set"></a> ⚙️ **Set**

**Alias:** `s`

```bash
npx @capgo/cli@latest organisation set
```

[DEPRECATED] Use "organization set" instead.

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-n** | <code>string</code> | Organization name |
| **-e** | <code>string</code> | Management email for the organization |
| **--enforce-2fa** | <code>boolean</code> | Enable 2FA enforcement for all organization members |
| **--no-enforce-2fa** | <code>boolean</code> | Disable 2FA enforcement for organization |
| **--password-policy** | <code>boolean</code> | Enable password policy enforcement for organization |
| **--no-password-policy** | <code>boolean</code> | Disable password policy enforcement |
| **--min-length** | <code>string</code> | Minimum password length (6-128, default: 10) |
| **--require-uppercase** | <code>boolean</code> | Require uppercase letter in password |
| **--no-require-uppercase** | <code>boolean</code> | Do not require uppercase letter |
| **--require-number** | <code>boolean</code> | Require number in password |
| **--no-require-number** | <code>boolean</code> | Do not require number |
| **--require-special** | <code>boolean</code> | Require special character in password |
| **--no-require-special** | <code>boolean</code> | Do not require special character |
| **--require-apikey-expiration** | <code>boolean</code> | Require all API keys to have an expiration date |
| **--no-require-apikey-expiration** | <code>boolean</code> | Do not require API key expiration |
| **--max-apikey-expiration-days** | <code>string</code> | Maximum days before API key expiration (1-365, null for no limit) |
| **--enforce-hashed-api-keys** | <code>boolean</code> | Enforce hashed/secure API keys (key value stored as hash, shown only once) |
| **--no-enforce-hashed-api-keys** | <code>boolean</code> | Allow plain-text API keys |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="organisation-delete"></a> 🗑️ **Delete**

**Alias:** `d`

```bash
npx @capgo/cli@latest organisation delete
```

[DEPRECATED] Use "organization delete" instead.

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |


## <a id="build"></a> 🔹 **Build**

🏗️  Manage native iOS/Android builds through Capgo Cloud.
⚠️ Native cloud build requests are currently in LIMITED BETA. Access is restricted.
 🔒 SECURITY GUARANTEE:
    Build credentials are NEVER stored on Capgo servers.
    They are used only during the build and auto-deleted after.
    Build outputs may optionally be uploaded for time-limited download links.
📋 BEFORE BUILDING:
   Save your credentials first:
   npx @capgo/cli build credentials save --appId <your-app-id> --platform ios
   npx @capgo/cli build credentials save --appId <your-app-id> --platform android
📤 CAPTURE THE OUTPUT URL FROM CI:
   Pass --output-record to persist the download URL + QR code, then read it
   back with `build last-output`:
   npx @capgo/cli build request <appId> --platform android --output-upload --output-record /tmp/build.json
   URL=$(npx @capgo/cli build last-output --path /tmp/build.json --field outputUrl)

### <a id="build-needed"></a> 🔹 **Needed**

```bash
npx @capgo/cli@latest build needed
```

🧭 Print "yes" and exit with code 1 if a native build is required; otherwise print "no" and exit with code 0. Command failures exit with code 2.

**Example:**

```bash
npx @capgo/cli@latest build needed com.example.app --channel production --verbose
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **-c** | <code>string</code> | Channel to compare against. Defaults to CapacitorUpdater.defaultChannel or the public default channel |
| **--package-json** | <code>string</code> | Paths to package.json files for monorepos (comma-separated) |
| **--node-modules** | <code>string</code> | Paths to node_modules directories for monorepos (comma-separated) |
| **--verbose** | <code>boolean</code> | Enable verbose output with detailed logging |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="build-init"></a> 🚀 **Init**

**Alias:** `onboarding`

```bash
npx @capgo/cli@latest build init
```

Set up build credentials interactively (iOS: certificates + profiles automated; Android: keystore + Google OAuth provisions GCP service account and Play Console invite)

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **-p** | <code>string</code> | Platform to onboard (ios or android). If omitted, auto-detects when only one native folder exists; prompts otherwise. |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--no-analytics** | <code>boolean</code> | Disable build onboarding analytics and terminal replay for this run |

### <a id="build-request"></a> 🔹 **Request**

```bash
npx @capgo/cli@latest build request
```

Request a native build from Capgo Cloud.
This command zips your project and uploads it to Capgo for a remote native build.
By default the finished artifact can go to the app store (when store credentials are saved)
and/or to Capgo storage as a time-limited download link (--output-upload).
 🔒 SECURITY: Credentials are never stored on Capgo servers. They are auto-deleted
    after build completion. Build outputs may optionally be uploaded for time-limited download links.
📋 PREREQUISITE: Save credentials first with:
   `npx @capgo/cli@latest build credentials save --appId <app-id> --platform <ios|android>`
Android AAB only (no Play upload): npx @capgo/cli@latest build request com.example.app --platform android --no-playstore-upload --output-upload
iOS IPA only (no TestFlight upload): npx @capgo/cli@latest build request com.example.app --platform ios --ios-distribution ad_hoc --output-upload

**Example:**

```bash
npx @capgo/cli@latest build request com.example.app --platform ios --path .
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--path** | <code>string</code> | Path to the project directory to build (default: current directory) |
| **--node-modules** | <code>string</code> | Paths to node_modules directories for monorepos (comma-separated) |
| **--platform** | <code>string</code> | Target platform: ios or android (required) |
| **--build-mode** | <code>string</code> | Build mode: debug or release (default: release) |
| **--build-certificate-base64** | <code>string</code> | iOS: Base64-encoded .p12 certificate |
| **--p12-password** | <code>string</code> | iOS: Certificate password (optional if cert has no password) |
| **--apple-id** | <code>string</code> | iOS: Apple ID email for app-specific password uploads (alternative to App Store Connect API key) |
| **--apple-app-specific-password** | <code>string</code> | iOS: App-specific password (xxxx-xxxx-xxxx-xxxx) for TestFlight uploads |
| **--apple-app-id** | <code>string</code> | iOS: Numeric App Store Connect app id (required together with --apple-id and --apple-app-specific-password) |
| **--apple-key-id** | <code>string</code> | iOS: App Store Connect API Key ID |
| **--apple-issuer-id** | <code>string</code> | iOS: App Store Connect Issuer ID |
| **--apple-key-content** | <code>string</code> | iOS: Base64-encoded App Store Connect API key (.p8) |
| **--app-store-connect-team-id** | <code>string</code> | iOS: App Store Connect Team ID |
| **--ios-scheme** | <code>string</code> | iOS: Xcode scheme to build (default: App) |
| **--ios-target** | <code>string</code> | iOS: Xcode target for reading build settings (default: same as scheme) |
| **--ios-distribution** | <code>string</code> | iOS: Distribution mode. app_store (default) uploads to TestFlight/App Store; ad_hoc skips store upload and builds an Ad Hoc IPA for device install. Use ad_hoc with --output-upload when the App Store app does not exist yet or you only need an IPA download. |
| **--ios-provisioning-profile** | <code>string</code> | iOS: Provisioning profile path or bundleId=path mapping (repeatable) |
| **--android-keystore-file** | <code>string</code> | Android: Base64-encoded keystore file |
| **--keystore-key-alias** | <code>string</code> | Android: Keystore key alias |
| **--keystore-key-password** | <code>string</code> | Android: Keystore key password |
| **--keystore-store-password** | <code>string</code> | Android: Keystore store password |
| **--play-config-json** | <code>string</code> | Android: Base64-encoded Google Play service account JSON |
| **--android-flavor** | <code>string</code> | Android: Product flavor to build (e.g. production). Required if your project has multiple flavors. |
| **--in-app-update-priority** | <code>string</code> | Android: Google Play in-app update priority for this release (integer 0–5; higher = more urgent). See https://developer.android.com/guide/playcore/in-app-updates. Precedence: CLI > env > saved credentials |
| **--no-playstore-upload** | <code>boolean</code> | Android: do not upload the AAB/APK to Google Play for this build (ignores saved Play credentials). Use when the Play app does not exist yet, or you only want a Capgo download link. Requires --output-upload. |
| **--submit-to-store-review** | <code>boolean</code> | After upload, submit the store release for review instead of leaving it as a draft/inactive build. Android marks the Play release completed; iOS submits the processed TestFlight build to App Store review. |
| **--store-release-name** | <code>string</code> | Store release name/version label. Android sends this as the Google Play version_name; iOS uses it as the App Store version when creating or reusing the editable version. |
| **--store-release-notes** | <code>string</code> | Default store release notes. Android uses this as the Play changelog; iOS uses it as the fallback App Store What's New text. |
| **--store-release-notes-locale** | <code>string</code> | Localized store release notes (repeatable), for example --store-release-notes-locale en-US="Bug fixes" --store-release-notes-locale fr-FR="Corrections". |
| **--ios-testflight-groups** | <code>string</code> | iOS: optional comma-separated TestFlight external group names or IDs for external beta distribution. |
| **--ios-automatic-release** | <code>boolean</code> | iOS: automatically release the App Store version after Apple approval. Default is manual release. |
| **--no-ios-automatic-release** | <code>boolean</code> | iOS: keep the App Store version waiting for manual release after Apple approval. |
| **--output-upload** | <code>boolean</code> | Upload the finished IPA/APK/AAB to Capgo storage and print a time-limited download link (and QR). Use with --no-playstore-upload (Android) or --ios-distribution ad_hoc (iOS) when you only need the artifact and are not publishing to the store yet. Precedence: CLI > env > saved credentials |
| **--no-output-upload** | <code>boolean</code> | Do not upload the finished IPA/APK/AAB to Capgo storage (no download link). Store upload still happens when Play/TestFlight credentials are configured. Precedence: CLI > env > saved credentials |
| **--output-retention** | <code>string</code> | Override output link TTL for this build only (1h to 7d). Examples: 1h, 6h, 2d. Precedence: CLI > env > saved credentials |
| **--output-record** | <code>string</code> | After a successful build, write a JSON record (jobId, status, outputUrl, qrCodeAscii, qrCodePngPath, finishedAt) to <path>. A PNG QR code is also written next to it as <path>.qr.png. Read fields back with `build last-output`. |
| **--skip-build-number-bump** | <code>boolean</code> | Skip automatic build number/version code incrementing. Uses whatever version is already in the project files. |
| **--no-skip-build-number-bump** | <code>boolean</code> | Override saved credentials to re-enable automatic build number incrementing for this build only. |
| **--skip-marketing-version-bump** | <code>boolean</code> | Skip automatic marketing version (CFBundleShortVersionString / versionName) bump when the app is already released. |
| **--no-skip-marketing-version-bump** | <code>boolean</code> | Override saved credentials to re-enable automatic marketing version bump for this build only. |
| **--sync-ios-version** | <code>boolean</code> | iOS: sync Xcode MARKETING_VERSION from package.json before uploading the project. |
| **--ai-analytics** | <code>boolean</code> | On build failure, send logs to Capgo AI for diagnosis. In interactive terminals this skips the upfront confirmation; in CI this auto-uploads and prints the analysis to stderr. |
| **--no-prescan** | <code>boolean</code> | Skip the automatic pre-build scan |
| **--prescan-ignore-fatal** | <code>boolean</code> | Run the pre-build scan but never block the build (report only) |
| **--prescan-skip** | <code>string</code> | Skip specific prescan check(s) by id (repeatable or comma-separated). Other checks still run. |
| **--prescan-warn** | <code>string</code> | Downgrade specific prescan check(s) to warning by id (repeatable or comma-separated). Check still runs. |
| **--fail-on-warnings** | <code>boolean</code> | Treat prescan warnings as fatal |
| **--send-logs-to-support** | <code>boolean</code> | On a CI/CD build failure, automatically upload the build logs to Capgo support (no email required). Capgo support is notified and will follow up by email. Additive to --ai-analytics. |
| **--send-logs** | <code>boolean</code> | Deprecated alias for --send-logs-to-support |
| **-a** | <code>string</code> | API key to link to your account |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |
| **--verbose** | <code>boolean</code> | Enable verbose output with detailed logging |

### <a id="build-sync-ios-version"></a> 🔹 **Sync-ios-version**

```bash
npx @capgo/cli@latest build sync-ios-version
```

Sync the local iOS Xcode MARKETING_VERSION from package.json.

**Example:**

```bash
npx @capgo/cli@latest build sync-ios-version --path .
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--path** | <code>string</code> | Path to the project directory (default: current directory) |
| **--check** | <code>boolean</code> | Check only; exit non-zero when MARKETING_VERSION is out of sync |

### <a id="build-prescan"></a> 🔹 **Prescan**

```bash
npx @capgo/cli@latest build prescan
```

Scan your project and saved credentials for problems that would fail a cloud build — before uploading anything.
Checks credentials (expiry, passwords, profile pairing), project state (cap sync, node_modules layout), and platform config. Runs automatically inside `build request`; this command runs it standalone (e.g. in CI).

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--platform** | <code>string</code> | Target platform: ios or android (required) |
| **--path** | <code>string</code> | Path to the project directory (default: current directory) |
| **-a** | <code>string</code> | API key to link to your account |
| **--android-flavor** | <code>string</code> | Android: product flavor the build will use |
| **--ios-dist** | <code>string</code> | iOS: distribution mode to validate against |
| **--json** | <code>boolean</code> | Output a machine-readable JSON report |
| **--fail-on-warnings** | <code>boolean</code> | Exit non-zero when warnings are found (CI) |
| **--ignore-fatal** | <code>boolean</code> | Diagnostic mode: report everything but always exit 0 |
| **--skip** | <code>string</code> | Skip specific check(s) by id (repeatable or comma-separated) |
| **--warn** | <code>string</code> | Downgrade specific check(s) to warning by id (repeatable or comma-separated) |
| **--verbose** | <code>boolean</code> | Enable verbose output with detailed logging |
| **--supa-host** | <code>string</code> | Custom Supabase host URL (for self-hosting or Capgo development) |
| **--supa-anon** | <code>string</code> | Custom Supabase anon key (for self-hosting) |

### <a id="build-last-output"></a> 🔹 **Last-output**

```bash
npx @capgo/cli@latest build last-output
```

Read the build output record written by a previous `build request --output-record`.
Prints the full JSON by default, a single field with --field, or the ASCII QR
code with --qr. Useful in CI to grab the download URL or QR for posting back
to a PR or issue.
Examples:
  npx @capgo/cli build last-output --path /tmp/build.json
  npx @capgo/cli build last-output --path /tmp/build.json --field outputUrl
  npx @capgo/cli build last-output --path /tmp/build.json --qr

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--path** | <code>string</code> | Path to the JSON record written by --output-record (required) |
| **--field** | <code>string</code> | Print a single field (one of: jobId, appId, platform, buildMode, status, outputUrl, qrCodeAscii, qrCodePngPath, finishedAt, schemaVersion) |
| **--qr** | <code>boolean</code> | Print the rendered ASCII QR code (shortcut for --field qrCodeAscii) |

### <a id="build-credentials"></a> 🔹 **Credentials**

Manage build credentials stored locally on your machine.
🔒 SECURITY:
   - Credentials saved to ~/.capgo-credentials/credentials.json (global) or .capgo-credentials.json (local)
   - When building, sent to Capgo but NEVER stored permanently
   - Deleted from Capgo immediately after build
   - Build outputs may optionally be uploaded for time-limited download links
📚 DOCUMENTATION:
   iOS setup: https://capgo.app/docs/cli/cloud-build/ios/
   Android setup: https://capgo.app/docs/cli/cloud-build/android/

#### <a id="build-credentials-apple-key"></a> 🔹 **Apple-key**

**Alias:** `asc-key`

```bash
npx @capgo/cli@latest build credentials apple-key
```

Create an App Store Connect team API key with a guided macOS helper (macOS only).
Opens a native window that walks you through Apple's App Store Connect UI in an
embedded browser, auto-captures the Issuer ID + Key ID, intercepts the one-time
.p8, validates it against Apple, and saves it to ~/.appstoreconnect/private_keys.
Progress statistics are forwarded to Capgo analytics (disable with CAPGO_DISABLE_TELEMETRY).
  npx @capgo/cli build credentials apple-key --appId com.example.app

**Example:**

```bash
Example:
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **-a** | <code>string</code> | API key to link to your account |
| **--appId** | <code>string</code> | Save the captured key into this app iOS build credentials |
| **--local** | <code>boolean</code> | Save into the per-project .capgo-credentials.json instead of the global file |
| **--json** | <code>boolean</code> | Print the captured Key ID / Issuer ID / .p8 path as JSON |

#### <a id="build-credentials-save"></a> 🔹 **Save**

```bash
npx @capgo/cli@latest build credentials save
```

Save build credentials locally for iOS or Android.
Credentials are stored in:
  - ~/.capgo-credentials/credentials.json (default, global)
  - .capgo-credentials.json in project root (with --local flag)
⚠️  REQUIRED BEFORE BUILDING: You must save credentials before requesting a build.
🔒 These credentials are NEVER stored on Capgo servers permanently.
   They are deleted immediately after the build completes.
📚 Setup guides:
   iOS: https://capgo.app/docs/cli/cloud-build/ios/
   Android: https://capgo.app/docs/cli/cloud-build/android/
  npx @capgo/cli build credentials save --platform ios \
    --certificate ./cert.p12 --p12-password "password" \
    --ios-provisioning-profile ./profile.mobileprovision \
    --apple-key ./AuthKey.p8 --apple-key-id "KEY123" \
    --apple-issuer-id "issuer-uuid" --apple-team-id "team-id"
Multi-target Example (app + widget extension):
  npx @capgo/cli build credentials save --platform ios \
    --ios-provisioning-profile ./App.mobileprovision \
    --ios-provisioning-profile com.example.widget=./Widget.mobileprovision \
    ...
  npx @capgo/cli build credentials save --platform android \
    --keystore ./release.keystore --keystore-alias "my-key" \
    --keystore-key-password "key-pass" \
    --play-config ./service-account.json
Local storage (per-project):
  npx @capgo/cli build credentials save --local --platform ios ...

**Example:**

```bash
iOS Example:
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--appId** | <code>string</code> | App ID (e.g., com.example.app) (required) |
| **--platform** | <code>string</code> | Platform: ios or android (required) |
| **--certificate** | <code>string</code> | iOS: Path to .p12 certificate file |
| **--ios-provisioning-profile** | <code>string</code> | iOS: Provisioning profile path or bundleId=path (repeatable) |
| **--p12-password** | <code>string</code> | iOS: Certificate password (optional if cert has no password) |
| **--apple-key** | <code>string</code> | iOS: Path to .p8 App Store Connect API key |
| **--apple-key-id** | <code>string</code> | iOS: App Store Connect API Key ID |
| **--apple-issuer-id** | <code>string</code> | iOS: App Store Connect Issuer ID |
| **--apple-team-id** | <code>string</code> | iOS: App Store Connect Team ID |
| **--ios-distribution** | <code>string</code> | iOS: Distribution mode |
| **--apple-id** | <code>string</code> | iOS: Apple ID email for app-specific password uploads (alternative to App Store Connect API key) |
| **--apple-app-specific-password** | <code>string</code> | iOS: App-specific password (xxxx-xxxx-xxxx-xxxx) for TestFlight uploads |
| **--apple-app-id** | <code>string</code> | iOS: Numeric App Store Connect app id (required together with --apple-id and --apple-app-specific-password) |
| **--keystore** | <code>string</code> | Android: Path to keystore file (.keystore or .jks) |
| **--keystore-alias** | <code>string</code> | Android: Keystore key alias |
| **--keystore-key-password** | <code>string</code> | Android: Keystore key password |
| **--keystore-store-password** | <code>string</code> | Android: Keystore store password |
| **--play-config** | <code>string</code> | Android: Path to Play Store service account JSON |
| **--android-flavor** | <code>string</code> | Android: Product flavor to build (e.g. production). Required if your project has multiple flavors. |
| **--in-app-update-priority** | <code>string</code> | Android: Google Play in-app update priority for future releases (integer 0–5; higher = more urgent). Omit to leave Play’s existing value untouched. |
| **--local** | <code>boolean</code> | Save to .capgo-credentials.json in project root instead of global ~/.capgo-credentials/ |
| **--output-upload** | <code>boolean</code> | Upload build outputs (IPA/APK/AAB) to Capgo storage and print download links |
| **--no-output-upload** | <code>boolean</code> | Do not upload build outputs (IPA/APK/AAB) to Capgo storage |
| **--output-retention** | <code>string</code> | Output link TTL: 1h to 7d (default: 1h). Examples: 1h, 6h, 2d |
| **--skip-build-number-bump** | <code>boolean</code> | Skip automatic build number/version code incrementing on future builds |
| **--no-skip-build-number-bump** | <code>boolean</code> | Re-enable automatic build number incrementing (default behavior) |
| **--skip-marketing-version-bump** | <code>boolean</code> | Skip automatic marketing version bump on future builds when the app is already released |
| **--no-skip-marketing-version-bump** | <code>boolean</code> | Re-enable automatic marketing version bump (default behavior) |

#### <a id="build-credentials-list"></a> 📋 **List**

```bash
npx @capgo/cli@latest build credentials list
```

List saved build credentials (passwords masked).
Shows what credentials are currently saved (both global and local).
Examples:
  npx @capgo/cli build credentials list  # List all apps
  npx @capgo/cli build credentials list --appId com.example.app  # List specific app

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--appId** | <code>string</code> | App ID to list (optional, lists all if omitted) |
| **--local** | <code>boolean</code> | List credentials from local .capgo-credentials.json only |

#### <a id="build-credentials-clear"></a> 🔹 **Clear**

```bash
npx @capgo/cli@latest build credentials clear
```

Clear saved build credentials.
Remove credentials from storage.
Use --appId and --platform to target specific credentials.
Examples:
  npx @capgo/cli build credentials clear  # Clear all apps (global)
  npx @capgo/cli build credentials clear --local  # Clear local credentials
  npx @capgo/cli build credentials clear --appId com.example.app --platform ios

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--appId** | <code>string</code> | App ID to clear (optional, clears all apps if omitted) |
| **--platform** | <code>string</code> | Platform to clear: ios or android (optional, clears all platforms if omitted) |
| **--local** | <code>boolean</code> | Clear from local .capgo-credentials.json instead of global |

#### <a id="build-credentials-update"></a> 🔹 **Update**

```bash
npx @capgo/cli@latest build credentials update
```

Update specific credentials without providing all of them again.
Update existing credentials by providing only the fields you want to change.
Platform is auto-detected from the options you provide.
Examples:
  npx @capgo/cli build credentials update --ios-provisioning-profile ./new-profile.mobileprovision
  npx @capgo/cli build credentials update --local --keystore ./new-keystore.jks

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--appId** | <code>string</code> | App ID (auto-detected from capacitor.config if omitted) |
| **--platform** | <code>string</code> | Platform: ios or android (auto-detected from options) |
| **--local** | <code>boolean</code> | Update local .capgo-credentials.json instead of global |
| **--certificate** | <code>string</code> | Path to P12 certificate file |
| **--ios-provisioning-profile** | <code>string</code> | Provisioning profile path or bundleId=path (repeatable, additive by default) |
| **--overwrite-ios-provisioning-map** | <code>boolean</code> | Replace the entire provisioning map instead of merging (default: merge) |
| **--p12-password** | <code>string</code> | P12 certificate password |
| **--apple-key** | <code>string</code> | Path to App Store Connect API key (.p8 file) |
| **--apple-key-id** | <code>string</code> | App Store Connect API Key ID |
| **--apple-issuer-id** | <code>string</code> | App Store Connect Issuer ID |
| **--apple-team-id** | <code>string</code> | App Store Connect Team ID |
| **--apple-id** | <code>string</code> | iOS: Apple ID email for app-specific password uploads (alternative to App Store Connect API key) |
| **--apple-app-specific-password** | <code>string</code> | iOS: App-specific password (xxxx-xxxx-xxxx-xxxx) for TestFlight uploads |
| **--apple-app-id** | <code>string</code> | iOS: Numeric App Store Connect app id (required together with --apple-id and --apple-app-specific-password) |
| **--ios-distribution** | <code>string</code> | iOS: Distribution mode |
| **--keystore** | <code>string</code> | Path to keystore file (.keystore or .jks) |
| **--keystore-alias** | <code>string</code> | Keystore key alias |
| **--keystore-key-password** | <code>string</code> | Keystore key password |
| **--keystore-store-password** | <code>string</code> | Keystore store password |
| **--play-config** | <code>string</code> | Path to Google Play service account JSON |
| **--android-flavor** | <code>string</code> | Android: Product flavor to build (e.g. production). Required if your project has multiple flavors. |
| **--in-app-update-priority** | <code>string</code> | Android: Google Play in-app update priority for future releases (integer 0–5; higher = more urgent). |
| **--output-upload** | <code>boolean</code> | Upload build outputs (IPA/APK/AAB) to Capgo storage and print download links |
| **--no-output-upload** | <code>boolean</code> | Do not upload build outputs (IPA/APK/AAB) to Capgo storage |
| **--output-retention** | <code>string</code> | Output link TTL: 1h to 7d. Examples: 1h, 6h, 2d |
| **--skip-build-number-bump** | <code>boolean</code> | Skip automatic build number/version code incrementing on future builds |
| **--no-skip-build-number-bump** | <code>boolean</code> | Re-enable automatic build number incrementing (default behavior) |
| **--skip-marketing-version-bump** | <code>boolean</code> | Skip automatic marketing version bump on future builds when the app is already released |
| **--no-skip-marketing-version-bump** | <code>boolean</code> | Re-enable automatic marketing version bump (default behavior) |

#### <a id="build-credentials-manage"></a> 🔹 **Manage**

```bash
npx @capgo/cli@latest build credentials manage
```

Interactively manage saved build credentials.
Browse stored credentials, view what's configured, export a CI/CD-ready .env file,
or delete a platform's credentials. Reuses the same TUI as `capgo init`.
Examples:
  npx @capgo/cli build credentials manage
  npx @capgo/cli build credentials manage --appId com.example.app
  npx @capgo/cli build credentials manage --appId com.example.app --platform ios
  npx @capgo/cli build credentials manage --local

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--appId** | <code>string</code> | App ID to manage (optional, prompts to pick if omitted) |
| **--platform** | <code>string</code> | Platform to manage: ios or android (optional, prompts to pick if omitted) |
| **--local** | <code>boolean</code> | Only browse local .capgo-credentials.json |

#### <a id="build-credentials-migrate"></a> 🔹 **Migrate**

```bash
npx @capgo/cli@latest build credentials migrate
```

Migrate legacy provisioning profile to the new multi-target format.
Converts BUILD_PROVISION_PROFILE_BASE64 to CAPGO_IOS_PROVISIONING_MAP.
Discovers the main bundle ID from your Xcode project automatically.
  npx @capgo/cli build credentials migrate --platform ios

**Example:**

```bash
Example:
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--appId** | <code>string</code> | App ID (auto-detected from capacitor.config if omitted) |
| **--platform** | <code>string</code> | Platform (only ios is supported) |
| **--local** | <code>boolean</code> | Migrate from local .capgo-credentials.json instead of global |


## <a id="notifications"></a> 🔹 **Notifications**

🔔 Set up Capgo native notifications in your Capacitor app.

### <a id="notifications-setup"></a> ⚙️ **Setup**

```bash
npx @capgo/cli@latest notifications setup
```

Install the Capgo notifications plugin, add Capacitor config, create a helper file, and run Capacitor sync.
Before sending production notifications, configure Android and iOS push credentials in the Capgo app Notifications tab.

**Example:**

```bash
npx @capgo/cli@latest notifications setup com.example.app
```

**Options:**

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--server-url** | <code>string</code> | Capgo API server URL |
| **--file** | <code>string</code> | Helper file to create (default: src/capgo-notifications.ts) |
| **--force** | <code>boolean</code> | Overwrite the helper file if it already exists |
| **--no-install** | <code>boolean</code> | Skip installing the notifications package |
| **--no-sync** | <code>boolean</code> | Skip Capacitor sync |
| **--capacitor-config** | <code>string</code> | Capacitor config source to update (useful with dynamic monorepo configs) |


## <a id="probe"></a> 🔹 **Probe**

```bash
npx @capgo/cli@latest probe
```

🔎 Probe the Capgo updates endpoint to check if an update is available for your app.
Sends a single request to the updates endpoint using your project's capacitor config
and reports whether an update would be delivered, or explains why not.

**Example:**

```bash
npx @capgo/cli@latest probe --platform ios
```

## <a id="options-probe"></a> Options (Probe)

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--platform** | <code>string</code> | Platform to probe: ios or android |


## <a id="mcp"></a> 🔹 **Mcp**

```bash
npx @capgo/cli@latest mcp
```

🤖 Start the Capgo MCP (Model Context Protocol) server for AI agent integration.
This command starts an MCP server that exposes Capgo functionality as tools for AI agents.
The server communicates via stdio and is designed for non-interactive, programmatic use.
Selected tools exposed via MCP:
  - capgo_list_apps, capgo_add_app, capgo_update_app, capgo_delete_app
  - capgo_upload_bundle, capgo_list_bundles, capgo_delete_bundle, capgo_cleanup_bundles
  - capgo_list_channels, capgo_add_channel, capgo_update_channel, capgo_delete_channel
  - capgo_get_current_bundle, capgo_check_compatibility
  - capgo_list_organizations, capgo_add_organization
  - capgo_star_repository
  - capgo_star_all_repositories
  - capgo_get_account_id, capgo_doctor, capgo_get_stats
  - capgo_request_build, capgo_generate_encryption_keys
Example usage with Claude Desktop:
  Add to claude_desktop_config.json:
  {
    "mcpServers": {
      "capgo": {
        "command": "npx",
        "args": ["@capgo/cli@latest", "mcp"]
      }
    }
  }

**Example:**

```bash
npx @capgo/cli@latest mcp
```

## <a id="options-mcp"></a> Options (Mcp)

| Param          | Type          | Description          |
| -------------- | ------------- | -------------------- |
| **--capacitor-config** | <code>string</code> | Capacitor config source to update (useful with dynamic monorepo configs) |



<!-- AUTO-GENERATED-DOCS-END -->

## Programmatic Usage (SDK)

You can use the Capgo CLI programmatically in your Node.js/TypeScript projects for automation and CI/CD pipelines.

### Installation

```bash
npm install @capgo/cli
```

### Example: Upload a Bundle

```typescript
import { CapgoSDK } from '@capgo/cli/sdk'

const sdk = new CapgoSDK({
  apikey: 'your-api-key'
})

await sdk.uploadBundle({
  appId: 'com.example.app',
  bundle: '1.0.0',
  path: './dist',
  channel: 'production'
})
```

### Example: CI/CD Automation

```typescript
import { CapgoSDK } from '@capgo/cli/sdk'

const sdk = new CapgoSDK({
  apikey: process.env.CAPGO_API_KEY
})

// Upload new version
await sdk.uploadBundle({
  appId: 'com.example.app',
  bundle: process.env.VERSION,
  path: './dist',
  channel: 'production'
})

// Cleanup old bundles
await sdk.cleanupBundles({
  appId: 'com.example.app',
  keep: 10
})
```

All CLI features are available as SDK methods. See the [TypeScript types](./src/sdk.ts) for the complete API reference.
