---
name: usage
description: Use when operating the Capgo CLI for app setup, OTA bundles, channels, organizations, encryption keys, account lookups, MCP integration, GitHub support commands, and native cloud builds.
---

# Capgo CLI Usage

Use this skill as the entry point for the Capgo CLI skill set.

TanStack Intent skills should stay focused and under the validator line limit, so the Capgo CLI guidance is split into multiple skills:

- `usage`: high-level command routing, shared invocation rules, and quick command selection.
- `release-management`: OTA bundle, channel, and encryption-key workflows.
- `native-builds`: native cloud build request and build-credential workflows.
- `organization-management`: organization, account, and deprecated organisation-alias workflows.

## Shared invocation rules

- Prefer `npx @capgo/cli@latest ...` in user-facing examples in this repo.
- Many commands can infer `appId` and related config from the current Capacitor project.
- Shared public flags commonly include `-a, --apikey <apikey>` and `--verbose` on commands that support verbose output.
- `--capacitor-config <path>` is a global option for dynamic monorepos: Capacitor still loads the active root config, while config-writing commands update the selected app-specific source file. On `mcp`, the target remains active for the server lifetime so config-writing MCP tools use the same source.

## Use this skill for quick routing

### Project setup and diagnostics

- `init [apikey] [appId]`: guided first-time setup for Capgo in a Capacitor app. The interactive flow now runs as a real Ink-based fullscreen onboarding so it uses the same UI stack as `build init` (alias: `build onboarding`), with a persistent dashboard, phase roadmap, progress cards, shared log area, and resume support. At startup, onboarding still recommends a clean git worktree before file edits; dirty repos show `Check again` first and also offer a non-recommended `Continue anyway` override. When dependency auto-detection fails on macOS, the flow opens a native file picker for `package.json` before falling back to manual path entry. If the local bundle ID already exists in the selected Capgo account, onboarding offers to reuse that app, then offers to delete and recreate it, then falls back to alternate bundle ID suggestions. If the user reuses a pending app that was already created in the web onboarding flow, the CLI syncs that selected dashboard app ID back into `capacitor.config.*` before the remaining steps continue. Outside that reused pending-app path, the CLI keeps using the local Capacitor app ID. It writes the new `autoUpdate` policy modes into config: `"atBackground"` for the default flow and `"always"` for instant updates. It can also offer a final `npx skills add https://github.com/Cap-go/capgo-skills -g -y` install step before the GitHub support prompt; if accepted, the support menu includes `Cap-go/capgo-skills` alongside the updater-only and all-Capgo choices. If native platforms are missing, the onboarding can offer to run `cap add` for you. The updater step now verifies that `@capgo/capacitor-updater` is both declared in the selected `package.json` and resolvable from `node_modules`; if automatic install or later build/sync fails, onboarding prints the manual command, waits for the user to type `ready`, re-checks, and only then continues. During the iOS run-on-device step, onboarding asks whether to use a physical iPhone/iPad or a simulator; for physical devices, it asks the user to connect and unlock the device, then offers a check-again loop before launching with the detected target. If iOS sync validation fails during onboarding, the CLI can offer to run a one-line native reset command, wait for you to type `ready` after a manual fix, surface `doctor`, and save a support bundle before you leave the flow.
- `init --no-analytics`: disables init onboarding analytics and terminal replay for that run.
- `run device [platform]`: run a Capacitor app on a connected device or simulator. In an interactive terminal, omitting `[platform]` asks whether to start on iOS or Android. The command lists available devices and simulators, includes a reload option, and resolves the `cap run` command. Use `npx @capgo/cli@latest run device ios --no-launch` to exercise iOS physical/simulator target selection and print the resolved command without launching the app.
- `login [apikey]`: store an API key locally.
- `doctor`: inspect installation health and gather troubleshooting details.
- `probe`: test whether the update endpoint would deliver an update.

### App-level operations

- `app add [appId]`: create an app in Capgo Cloud.
- `app list`: list apps under the current account.
- `app delete [appId]`: remove an app.
- `app set [appId]`: update app settings such as name, icon, retention, metadata exposure, and preview access with `--preview` or `--no-preview`.
- `app setting [path]`: update Capacitor config values programmatically.
- `app debug [appId]`: listen for live-update debug events, optionally for one device.

### Docs and agent integrations

- `mcp`: start the Capgo MCP server for AI-agent integrations; pass `--capacitor-config <path>` when its config-writing tools should target an app-specific source.

### GitHub support commands

- `star [repository]`: star one Capgo repository, defaulting to `capacitor-updater`.
- `star-all [repositories...]`: star all Capgo repositories matching the default filter, with delay and concurrency controls. The default set includes `capacitor-*` repositories plus `Cap-go/CLI`, `Cap-go/capgo`, and `Cap-go/capgo-skills`.

## Related skills

### `release-management`

Load `skills/release-management/SKILL.md` when working with:

- `bundle upload`, `bundle list`, `bundle delete`, `bundle cleanup`
- `bundle compatibility`, `bundle releaseType`, `bundle zip`, `bundle encrypt`, `bundle decrypt`
- `channel add`, `channel list`, `channel delete`, `channel set`, `channel currentBundle`
- `get-qr`
- `key save`, `key create`, `key delete_old`

### `native-builds`

Load `skills/native-builds/SKILL.md` when working with:

- `build request`
- `build needed`
- `build credentials save`
- `build credentials list`
- `build credentials clear`
- `build credentials update`
- `build credentials migrate`

### `organization-management`

Load `skills/organization-management/SKILL.md` when working with:

- `account id`
- `organization list`, `organization add`, `organization members`, `organization set`, `organization delete`
- deprecated `organisation` aliases

## Common command examples

```bash
npx @capgo/cli@latest init YOUR_API_KEY com.example.app
npx @capgo/cli@latest run device ios --no-launch
npx @capgo/cli@latest login YOUR_API_KEY
npx @capgo/cli@latest doctor
npx @capgo/cli@latest probe --platform ios
npx @capgo/cli@latest app add com.example.app --name "My App"
npx @capgo/cli@latest get-qr com.example.app --channel production
npx @capgo/cli@latest star-all
```
