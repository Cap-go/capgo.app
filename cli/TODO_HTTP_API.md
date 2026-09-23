# CLI HTTP API migration TODOs

## Missing endpoints (block full supabase-js removal)

- [x] GET private/cli/identity (`request_actor_user_id` + email + 2FA flags)
- [x] POST private/cli/check-permission (`cli_check_permission` / `assertCliPermission` / `hasCliPermission`)
- [x] GET private/cli/organizations (`get_orgs_v7` / rich org list with plan + warnings)
- [x] Billing/entitlement RPCs (`is_paying_org`, `is_trial_org`, `has_usage_credits_org`, `is_allowed_action_org*`, `checkPlanValid`)
- [x] 2FA member/org access RPCs (`reject_access_due_to_2fa_*`, `check_org_members_2fa_enabled`, `has_2fa_enabled`)
- [x] Password policy member status RPC (`check_org_members_password_policy`)
- [x] Org CLI warnings RPC (`get_organization_cli_warnings`)
- [ ] POST organization via API key (JWT-only `middlewareAuth` today)
- [ ] Icon / storage uploads via Capgo HTTP (still supabase storage)
- [x] Channel-scoped current bundle HTTP that preserves `channel.read` RBAC (`get_channel_current_bundle_rbac`)
- [x] PUT app fields still missing from HTTP: `allow_preview`, `build_timeout_seconds`, `default_upload_channel`
- [x] GET organization security fields (`enforcing_2fa`, `password_policy_config`, API-key policy flags)
- [x] GET channel fields still missing from HTTP response: `ios`, `android`, `owner_org`
- [ ] Bundle upload finalize / version upsert / encryption field writes (keep existing partial `invokeCapgoCliApi` in upload)
- [ ] Bundle compatibility `native_packages` dedicated endpoint (today via full GET bundle rows)
- [ ] User-scoped storage cleanup path `apps/${appId}/${userId}` on app delete

## Partial (endpoint exists, CLI still needs more)

- [x] GET organization — security settings now included in HTTP response
- [x] GET organization/members — member list migrated; 2FA/password enrichment now HTTP
- [x] PUT app — preview/timeout/default upload channel migrated; icon storage still SDK
- [x] GET channel — list/find includes `ios`, `android`, `owner_org`
- [ ] GET/DELETE bundle — list/delete migrated; empty list currently returns API error that CLI maps to `[]`
- [ ] POST channel — create/update/set migrated; create no longer sends `created_by`/`owner_org` (server-owned)
- [ ] DELETE app — DB delete migrated; legacy user storage cleanup still SDK

## Still on supabase-js (file references)

- `cli/src/utils.ts` — `updateOrCreateChannel` fallback, storage helpers
- `cli/src/app/set.ts` — icon storage upload; download-channel helpers
- `cli/src/app/delete.ts` — user-scoped storage cleanup
- `cli/src/app/add.ts` — icon storage upload; org permission RPCs
- `cli/src/bundle/upload.ts` — version upsert / finalize / encryption writes
- `cli/src/bundle/compatibility.ts` — native package reads when not using HTTP bundle payload
- `cli/src/channel/set.ts` — `checkCompatibilityNativePackages` still needs supabase client
