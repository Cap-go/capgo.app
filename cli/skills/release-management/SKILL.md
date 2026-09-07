---
name: release-management
description: Use when working on Capgo OTA release workflows including bundle uploads, compatibility checks, channel management, cleanup, and encryption key setup.
---

# Capgo CLI Release Management

Use this skill for OTA update workflows in Capgo Cloud.

## Shared notes

- Prefer `npx @capgo/cli@latest ...` examples.
- `appId` can often be inferred from the current Capacitor project.
- Shared public flags often include `-a, --apikey`.
- Preview QR workflows require app preview to be enabled before the QR code can be printed.
- `--capacitor-config <path>` is global. With a dynamic root config selector such as `CAP_APP`, it keeps loading the root config and writes config changes to the selected app-specific source.

## Preview QR workflows

### `get-qr [appId] [target]`

- Example: `npx @capgo/cli@latest get-qr com.example.app --bundle 1.2.3`
- Example: `npx @capgo/cli@latest get-qr com.example.app --channel production`
- Example: `npx @capgo/cli@latest get-qr com.example.app production --type channel`
- Use to print a terminal QR code for a bundle or channel preview.
- The target can be a bundle name, bundle id, channel name, or channel id.
- If a positional target matches both a bundle and a channel, add `--type bundle` or `--type channel`.
- Preview must already be enabled for the app; enable it with `npx @capgo/cli@latest app set com.example.app --preview`.
- Key options:
  - `--bundle <bundle>`
  - `--channel <channel>`
  - `--type <bundle|channel>`
  - `-a, --apikey <apikey>`

## Bundle workflows

### `bundle upload [appId]`

- Alias: `u`
- Example: `npx @capgo/cli@latest bundle upload com.example.app --path ./dist --channel production,beta`
- Progressive rollout example: `npx @capgo/cli@latest bundle upload com.example.app --path ./dist --channel production --rollout 10`
- Advance an existing rollout: `npx @capgo/cli@latest bundle upload com.example.app --path ./dist --channel production --rollout-advance`
- Key behavior:
  - Bundle version must be greater than `0.0.0` and unique.
  - Deleted versions cannot be reused.
  - External URL mode is useful for very large or privacy-sensitive bundles.
  - Encryption is recommended for trustless distribution.
  - Interactive prompts are disabled automatically in CI and other non-interactive sessions so uploads do not block automation.
  - Optional upload prompts can remember the user's answer on the current machine so future uploads can skip the same question.
  - `--channel` accepts a single channel or a comma-separated list such as `production,beta`.
  - When multiple channels are provided, channels that already have the uploaded checksum are skipped and the remaining channels are assigned.
  - Use `--qr-preview` to print a terminal QR code for the uploaded bundle after a successful upload. App preview must be enabled first.
  - Use `--send-update-notification` to queue native update-check notifications for channels whose linked bundle changed. Native notifications and push update notifications must be enabled for the app.
- Important options:
  - `-p, --path <path>`
  - `-c, --channel <channel[,channel...]>`
  - `--rollout <percentage>`
  - `--rollout-percentage-bps <basisPoints>`
  - `--rollout-advance` (promote the current rollout target to stable, then set the uploaded bundle as the new rollout; reuses the previous percentage unless `--rollout` or `--rollout-percentage-bps` is also set)
  - `--rollout-cache-ttl-seconds <seconds>`
  - `-e, --external <url>`
  - `--iv-session-key <key>`
  - `-b, --bundle <bundle>`
  - `--link <link>`
  - `--comment <comment>`
  - `--min-update-version <minUpdateVersion>`
  - `--auto-min-update-version`
  - `--ignore-metadata-check`
  - `--fail-on-incompatible` (fail the upload instead of uploading when the bundle is incompatible with a target channel's current native packages; cannot be combined with `--ignore-metadata-check`)
  - `--fail-on-active-rollout` (fail the upload when a target channel has an active progressive rollout and this upload would link the bundle as stable without `--rollout` or `--rollout-advance`; use in CI to block accidental rollout resets)
  - `--ignore-checksum-check`
  - `--force-crc32-checksum`
  - `--timeout <timeout>`
  - `--zip`
  - `--tus`
  - `--tus-chunk-size <tusChunkSize>`
  - `--delta` (refuses over 10,000 files — delta tracks each file; use `--no-delta` for a full zip, or reduce build files)
  - `--delta-only`
  - `--no-delta`
  - `--encrypted-checksum <encryptedChecksum>`
  - `--auto-set-bundle`
  - `--dry-upload`
  - `--package-json <packageJson>`
  - `--node-modules <nodeModules>`
  - `--encrypt-partial`
  - `--delete-linked-bundle-on-upload`
  - `--no-brotli-patterns <patterns>`
  - `--disable-brotli`
  - `--version-exists-ok`
  - `--self-assign`
  - `--qr-preview`
  - `--send-update-notification`
  - S3 options: `--s3-region`, `--s3-apikey`, `--s3-apisecret`, `--s3-endpoint`, `--s3-bucket-name`, `--s3-port`, `--no-s3-ssl`
  - Signing options: `--key-v2`, `--key-data-v2`, `--bundle-url`, `--no-key`, `--display-iv-session`
  - Deprecated options still supported: `--multipart`, `--partial`, `--partial-only`

### `bundle compatibility [appId]`

- Example: `npx @capgo/cli@latest bundle compatibility com.example.app --channel production`
- Use to check whether a bundle is safe for a given channel.
- Key options:
  - `-c, --channel <channel>`
  - `--text`
  - `--package-json <packageJson>`
  - `--node-modules <nodeModules>`

### `bundle releaseType [appId]`

- Example: `npx @capgo/cli@latest bundle releaseType com.example.app --channel production`
- Prints `native` or `OTA` based on channel compatibility.
- Key options:
  - `-c, --channel <channel>`
  - `--package-json <packageJson>`
  - `--node-modules <nodeModules>`

### `bundle list [appId]`

- Alias: `l`
- Example: `npx @capgo/cli@latest bundle list com.example.app`

### `bundle delete [bundleId] [appId]`

- Alias: `d`
- Example: `npx @capgo/cli@latest bundle delete BUNDLE_ID com.example.app`

### `bundle cleanup [appId]`

- Alias: `c`
- Example: `npx @capgo/cli@latest bundle cleanup com.example.app --bundle=1.0 --keep=3`
- Notes:
  - Linked bundles are preserved unless `--ignore-channel` is used.
- Key options:
  - `-b, --bundle <bundle>`
  - `-k, --keep <keep>`
  - `-f, --force`
  - `--ignore-channel`

### `bundle zip [appId]`

- Example: `npx @capgo/cli@latest bundle zip com.example.app --path ./dist`
- Notes:
  - Produces a checksum for encryption workflows.
  - Use `--json` for machine-readable output.
- Key options:
  - `-p, --path <path>`
  - `-b, --bundle <bundle>`
  - `-n, --name <name>`
  - `-j, --json`
  - `--no-code-check`
  - `--key-v2`
  - `--package-json <packageJson>`

### `bundle encrypt [zipPath] [checksum]`

- Example: `npx @capgo/cli@latest bundle encrypt ./myapp.zip CHECKSUM`
- Notes:
  - Returns the `ivSessionKey` needed for upload and later decryption.
- Key options:
  - `--key <key>`
  - `--key-data <keyData>`
  - `-j, --json`
  - `--package-json <packageJson>`

### `bundle decrypt [zipPath] [checksum]`

- Example: `npx @capgo/cli@latest bundle decrypt ./myapp_encrypted.zip CHECKSUM`
- Notes:
  - Mainly for testing.
  - Prints the base64 session key for verification.
- Key options:
  - `--key <key>`
  - `--key-data <keyData>`
  - `--checksum <checksum>`
  - `--package-json <packageJson>`

## Channel workflows

### `channel add [channelId] [appId]`

- Alias: `a`
- Example: `npx @capgo/cli@latest channel add production com.example.app --default`
- Key options:
  - `-d, --default`
  - `--self-assign`

### `channel list [appId]`

- Alias: `l`
- Example: `npx @capgo/cli@latest channel list com.example.app`

### `channel delete [channelId] [appId]`

- Alias: `d`
- Example: `npx @capgo/cli@latest channel delete production com.example.app`
- Key options:
  - `--delete-bundle`
  - `--success-if-not-found`

### `channel currentBundle [channel] [appId]`

- Example: `npx @capgo/cli@latest channel currentBundle production com.example.app`
- Key options:
  - `-c, --channel <channel>`
  - `--quiet`

### `channel set [channelId] [appId]`

- Alias: `s`
- Example: `npx @capgo/cli@latest channel set production com.example.app --bundle 1.0.0 --state default`
- Notes:
  - One channel must remain default.
  - Supports update policies `major`, `minor`, `metadata`, `patch`, and `none`.
  - Supports platform and device targeting.
  - Use `--qr-preview` to print a terminal QR code for the updated channel. App preview must be enabled first.
  - Use `--send-update-notification` with bundle, latest, latest remote, rollout target, or rollout promote changes to make matching devices check for updates.
- Key options:
  - `-b, --bundle <bundle>`
  - `-s, --state <state>`
  - `--latest-remote`
  - `--latest`
  - `--downgrade`, `--no-downgrade`
  - `--ios`, `--no-ios`
  - `--android`, `--no-android`
  - `--self-assign`, `--no-self-assign`
  - `--disable-auto-update <disableAutoUpdate>`
  - `--dev`, `--no-dev`
  - `--prod`, `--no-prod`
  - `--emulator`, `--no-emulator`
  - `--device`, `--no-device`
  - `--package-json <packageJson>`
  - `--ignore-metadata-check`
  - `--qr-preview`
  - `--send-update-notification`

## Encryption key workflows

### `key save`

- Example: `npx @capgo/cli@latest key save --key ./path/to/key.pub`
- Notes:
  - Saves the public key in Capacitor config.
  - Useful for CI.
  - Recommended not to commit the key.
- Key options:
  - `-f, --force`
  - `--key <key>`
  - `--key-data <keyData>`

### `key create`

- Example: `npx @capgo/cli@latest key create`
- Notes:
  - Creates `.capgo_key_v2` and `.capgo_key_v2.pub`.
  - Saves the public key to Capacitor config.
  - Never commit the private key.
- Key options:
  - `-f, --force`

### `key delete_old`

- Example: `npx @capgo/cli@latest key delete_old`
