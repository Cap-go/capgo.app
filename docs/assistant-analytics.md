# Assistant usage analytics

The console emits these PostHog events on web, iOS and Android. Existing hosted MCP telemetry is unchanged; use the dedicated assistant events to avoid mixing other MCP clients into assistant usage.

| Event | Metadata |
| --- | --- |
| Assistant Opened | connected |
| Assistant Connection Started | trigger=connect |
| Assistant Connection Finished | trigger, outcome, duration_ms, error_code |
| Assistant Turn Started | trigger=message or confirmation |
| Assistant Turn Finished | trigger, outcome, duration_ms, error_code |
| Assistant Tool Finished | catalog tool_name, outcome |
| Assistant Disconnected | no event-specific metadata |

All events include platform (web/ios/android), schema_version=1 and deployment (production/non-production). Production means the production API host. PostHog uses the console's existing user identification; these events add no account details, prompts, replies, tool arguments/results, authentication tokens, callback URLs or raw exception text. Errors use an explicit code allowlist; unknown errors become `unknown`. Replay body/header suppression and the assistant's capture exclusion remain enabled.

Each connection/turn start has at most one terminal event. Closing the app or a blocked analytics client can leave a start without a result. A paste retry after a failed sign-in is a new attempt. Connections include repairs of the assistant Capgo key when ChatGPT is already connected. Turn duration includes authentication, model calls and tools. Success means the assistant returned a reply or card, including the existing action-summary fallback; it does not imply every tool succeeded. Tool results are tracked separately, even when a later model request fails.

## Reporting

The separate admin dashboard adds Product → Assistant (`/admin/dashboard/assistant`) and a read-only `/private/assistant-usage` aggregate. It uses the existing PostHog read configuration and Cloudflare Access boundary; no database migration or new credentials are required. It can deploy before instrumentation and will show no recorded activity until the console ships.

Filter PostHog insights to `deployment=production` and `schema_version=1`. Count distinct users on `Assistant Turn Started` for active users; do not sum daily distinct users to get period users. For response success rate divide successful `Assistant Turn Finished` events by all recorded turn results. Split connection results by outcome and tool results by tool_name. Durations are milliseconds. The report uses UTC, a start-inclusive/end-exclusive range, and reports unavailable reads as errors rather than zero usage.

Counts begin at deployment and may undercount due to blockers. Earlier assistant activity cannot be reconstructed from generic API-key MCP events. Post-merge verification: complete one connection and a harmless read-only chat/tool call; check the dedicated events and their scalar metadata in PostHog, then confirm the admin totals after ingestion. CI and query validation alone do not prove production event delivery.
