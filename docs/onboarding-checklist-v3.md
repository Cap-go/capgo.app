# OTA checklist v3

## Assignment

`ota_todo_list_v3` is a persisted Capgo user A/B assignment: exact `ota` intent, 50% treatment A / 50% control B. Other intents, including `both`, are excluded. The app API ensures missing assignments exist before creating an app. A before-insert trigger assigns version 3 only when the app creator has treatment A and also created the owning organization. This works for later apps and additional creator-owned organizations, including direct authenticated inserts. The trigger runs after the onboarding ledger protection trigger and records the authenticated creator. It does not run on updates or migrate existing apps. Default version stays 2; v1/v2 UI and CLI completion rules remain unchanged.

Todo-list versions are separate from PostHog wizard versions. The new assignment does not enter the wizard version resolver. Step events carry `todo_list_version: 3`; channel dialog events carry `channel_flow_origin: todo_list` while normal wizard channel events keep `onboarding` origin.

## Progress

`POST /private/onboarding_progress` accepts `{ appId, N, initial? }`. Authentication and app-read authorization precede an RLS-protected read of that exact app on every request. The console sends one request every two seconds, increments N, resets it when switching apps, and discards stale responses. Initial load and explicit refresh check all four observations. Otherwise:

| N % 5 | Additional check |
| --- | --- |
| 0 | Any channel exists for this app |
| 1 | A device has contacted the updater, without requiring a download |
| 2 | A non-placeholder bundle has uploaded archive metadata, a completed manifest, or a registered external URL |
| 3 | A real bundle's `set` event was reported by a device |
| 4 | Saved app onboarding only |

Additional checks need the corresponding app/device/log read permissions. No public-admin read client is introduced. On v3, proven milestones are merged under a row lock with app-settings or organization-create authorization rechecked in the transaction. Concurrent CLI progress and histories are preserved. Device/publication/application milestones stay checked after their evidence is observed; channels can be unchecked after deletion. Failed queries leave confirmed status unchanged. Polling stops on completion/dismissal and unmount.

Both poll persistence and CLI progress writes acquire the existing `lock_rbac_orgs` transaction lock before the app row lock. Membership/role revocation uses that same organization lock, so a write that waits for a revocation checks the newly committed permissions before merging or completing onboarding. If the app changes organizations during lock acquisition, the entire transaction rolls back before retrying with the new organization lock. Three unsuccessful attempts return a retryable HTTP 409 instead of dropping progress. Hashed API keys use the authenticated request key for both transactional permission checks; SQL parameter logging is disabled on these write transactions.

Requests combining app settings and onboarding progress commit both in that same locked transaction. Settings updates run as the verified caller's PostgreSQL role with caller JWT/header context, preserving the existing RLS policies. The backend role/context is restored before merging backend-owned progress. A failed permission check, settings write, or progress merge rolls back the whole request. Role and request context changes are transaction-local and are reset by rollback as well as explicitly restored on success.

`add_code` and `add_updater` retain init reporting. No backend observation marks app-ready code complete. V3 ignores old init's intermediate platform/build/encryption/closing steps and does not let a closing `completed` report bypass the seven milestones. Init reports cannot prematurely complete the three backend-observed goals. The log reader bypasses onboarding sample logs for these checks.

## SQL execution and scale

The merger is a pure JSON function with no table reads. The new trigger executes once per inserted app under its security-definer owner; its only lookups are `users.id` and `orgs.id` primary keys. Neither function is exposed to anon/authenticated callers: explicit revokes cover PUBLIC and both roles, including inherited default function grants. Both use an empty search path and explicit postgres ownership. Existing RLS functions are unchanged.

The CLI/MCP login lookup uses `idx_apps_onboarding_login_creator`, a creator-expression index restricted to versions 2 and 3. Poll reads constrain `apps.app_id`, `channels.app_id`, and `app_versions.app_id`, using their existing indexed paths. Version matching also constrains `(app_id, name)`; archive metadata joins use the metadata primary key. Stored log/device helpers retain their existing app filters and bounded result limits (10/1); no plugin hot path or cron is added.

The organization lock runs once per authorized backend write transaction attempt (at most three attempts), through the service-backed connection, after the initial request permission check. It uses the already existing service-role-only SQL function and does not add any RPC, RLS, view, trigger, or plugin call path. The lock function touches no tables; its advisory key comes from two exact `apps.app_id` primary-key reads around acquisition. With 1,000,000 synthetic apps, those reads used `apps_pkey` with one row each (0.017 ms and 0.024 ms execution, respectively); the cold advisory-lock call took 5.149 ms. No sequential scans occurred. The concurrency regression uses two native PostgreSQL connections to prove the writer waits for revocation and then reads the changed permission. Locally it runs with the production lock function and an isolated permission model; CI runs it against the full database RBAC implementation.

The assignment predicate was measured against temporary tables with 1,000,000 user rows and 100,000 organization rows. `EXPLAIN (ANALYZE, BUFFERS)` showed one primary-key index scan per table, one resulting row, 0.398 ms planning and 0.038 ms execution, with no sequential scans. These are synthetic local measurements, not production timing guarantees. Actual PostgreSQL tests verify function ACLs, empty search paths, protected direct inserts and fixed versions. Tinbase applies broad function grants after migrations; the ACL checks run through its native socket after reapplying this migration, and run normally in the Docker backend suite.

## Dashboard exploration

Explore dashboard opens the app overview. For v3, the Getting started route opens the fullscreen seven-goal setup instead of the legacy four-goal wrapper, regardless of exploration mode or the channel-flow assignment. A refresh after exploration offers Continue exploring, Come back to the setup, or Don't show this again. The last choice stores a user-scoped browser-local preference; it dismisses only this reminder, not onboarding. Continuing hides the reminder for the current page, while a later refresh can show it again. Finished/dismissed apps are excluded. Resuming setup selects the owning organization of the requested app, including after exploring a different organization.

Getting started sidebar links point directly to fullscreen setup for v3 apps. Existing `/app/:app/getting-started` URLs resolve through a router guard after authentication and before any dashboard layout mounts. The guard reads the app's frozen version using the authenticated Supabase client and an exact `app_id` filter; v1/v2 retain the legacy page.

## Review preview

Start the real frontend and visit `/playwright/fixtures/onboarding-setup.html?view=flow&version=3&resume=com.example.onboarding-preview&step=setup`; change version to 2 for the control. It mounts AppOnboardingFlow with synthetic identity and intercepted requests. No production writes are sent. Screenshots and the repository visual report are in `docs/pr-assets/onboarding-v3`.
