# Local and hosted MCP responsibilities

Use the two servers together. Add `https://api.capgo.app/mcp` through your client's remote MCP configuration and run `npx @capgo/cli@latest mcp` for its local companion. Give the connections distinct names, such as `capgo-cloud` and `capgo-local`.

The CLI MCP exposes operations that require files, credentials, processes or onboarding state on your computer. It does not proxy cloud tools or duplicate the hosted skill catalog. Normal CLI commands and SDK methods remain available, including cloud management commands.

| Responsibility | Server and tools |
| --- | --- |
| Accounts, organizations, apps, uploaded bundles, channels, devices, webhooks and notifications | Hosted MCP |
| Observe, usage statistics, CI/cloud job status, logs and cancellation | Hosted MCP |
| Documentation search and skills | Hosted `capgo_search_docs`, `capgo_list_skills`, `capgo_get_skill`, resources and skills extension |
| Project selection and diagnostics | Local `capgo_set_project_dir`, `capgo_doctor`, `capgo_probe` |
| Package and upload local web assets; compare local native dependencies | Local `capgo_upload_bundle`, `capgo_check_compatibility` |
| Generate and save encryption keys | Local `capgo_generate_encryption_keys` |
| Package local source and signing credentials for a native build | Local `capgo_request_build` |
| Guided signing and OTA setup, persisted progress, credential files | Local Builder and live-update onboarding tools, `capgo_builder_credentials_manage` |
| Local build child process and log file | Local `start_capgo_build`, `capgo_build_wait`, `capgo_build_logs`, `cancel_capgo_build` |
| Credentials saved on this computer | Local `capgo_login`, `capgo_whoami`, `capgo_logout` |
| Repository starring using the locally authenticated `gh` CLI | Local `capgo_star_repository`, `capgo_star_all_repositories` |

## Authentication and similarly named tools

Authorize each connection separately. Local `capgo_login` saves a CLI key; it does not sign in to the hosted server. Local `capgo_whoami` reports the saved key's source and identity, while hosted `capgo_whoami` describes that remote connection. The keys may belong to different users or have different app access.

Local `capgo_request_build` packages project files and signing credentials from disk. Hosted `capgo_request_build` handles the cloud request/upload workflow and cannot read your project. Use each server's input schema; similarly named tools are not interchangeable.

## Migrating cloud tool calls

Cloud-only tools are no longer registered by the local MCP. Connect the hosted server, authorize it and inspect its `tools/list` before migrating a call. Names, IDs and argument conventions can differ; do not replay local arguments unchanged.

| Previous local operation | Hosted operation |
| --- | --- |
| Account, organization and member management | Corresponding hosted account/organization tools; use `capgo_whoami` for identity |
| App, bundle and channel CRUD | Corresponding hosted tools; inspect their schemas |
| `capgo_get_current_bundle` | `capgo_get_channel` |
| `capgo_promote_channel` | Read the source channel, then update the target channel using the hosted schema and applicable compatibility checks |
| `capgo_cleanup_bundles` | List bundles and channels, review which versions to retain, then delete only the selected bundles |
| `capgo_get_stats`, `capgo_observe` | Hosted Observe and statistics tools |
| `capgo_get_build_status`, `capgo_get_build_logs` | Hosted tools with a cloud `job_id` and `appId` |
| `capgo_search_docs`, skill tools and resources | Hosted MCP |

Local onboarding build IDs belong to the current local process/session. Use `capgo_build_wait` and `capgo_build_logs` for those IDs. Cloud job IDs returned by `capgo_request_build` belong to hosted build monitoring. Stopping `cancel_capgo_build` ends the local watcher; a submitted cloud job may continue. Cancel that cloud job separately only when requested.

Reading a skill does not authorize its actions. Existing confirmation, credential handling and API permissions still apply. Skill files continue to ship in the CLI npm package for skill-aware clients, but MCP skill discovery lives on the hosted server.
