---
name: observe
description: Use when querying Capgo Observe metrics, launch timings, crashes, WebView loads, device timelines, or per-screen navigation from the CLI, SDK, or MCP.
---

# Capgo Observe

Query existing Observe stats so agents and scripts can act on the data. Dashboards stay visual; this surface is for `findings` plus a next query.

Capgo has no session id. Treat `device_id` + time window as the session. Start with `summary` and follow `findings[].next`.

Navigation does not need Expo Router. Listen to `history.pushState`, `history.replaceState`, `popstate`, `hashchange`, and Capacitor App `appUrlOpen`, then send stats action `app_nav` with `metadata.route` (or `path`) and optional `duration_ms`.

## CLI

```bash
npx @capgo/cli@latest observe summary
npx @capgo/cli@latest observe metrics --action app_launch_ready --sort slowest --json
npx @capgo/cli@latest observe events --action app_crash_native
npx @capgo/cli@latest observe device DEVICE_ID --json
npx @capgo/cli@latest observe versions
npx @capgo/cli@latest observe routes --json
```

Shared flags: `-a, --apikey`, `--days` (`1`, `3`, `7`, `30`), `--action`, `--sort`, `--limit`, `--version-name`, `--json`.

## MCP

Call `capgo_observe` with `view=summary` first. Follow `findings[].next`. Use `view=device` and `deviceId` for the timeline.

## Views

- `summary`: findings, handoff prompt, overview
- `metrics`: timed samples (launch, WebView, `app_nav`)
- `events`: action counts and latest devices
- `device`: ordered timeline for one `device_id`
- `versions`: per-bundle launch/issue breakdown
- `routes`: grouped by `metadata.route` / `path` / `url`
