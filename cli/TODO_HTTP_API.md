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
- [x] Icon / storage uploads via Capgo HTTP (`POST private/cli/storage/icon`)
- [x] Channel-scoped current bundle HTTP that preserves `channel.read` RBAC (`get_channel_current_bundle_rbac`)
- [x] PUT app fields still missing from HTTP: `allow_preview`, `build_timeout_seconds`, `default_upload_channel`
- [x] GET organization security fields (`enforcing_2fa`, `password_policy_config`, API-key policy flags)
- [x] GET channel fields still missing from HTTP response: `ios`, `android`, `owner_org`
- [x] Bundle upload finalize / version upsert / encryption field writes (`POST /bundle/upsert`)
- [x] Bundle compatibility `native_packages` via `GET /channel/current-bundle` (channel bundle + metadata payload)
- [x] User-scoped storage cleanup path `apps/${appId}/${userId}` on app delete (server-side in `DELETE /app`)

## Partial (endpoint exists, CLI still needs more)

- [x] GET organization — security settings now included in HTTP response
- [x] GET organization/members — member list migrated; 2FA/password enrichment now HTTP
- [x] PUT app — preview/timeout/default upload channel migrated; icon upload now HTTP
- [x] GET channel — list/find includes `ios`, `android`, `owner_org`
- [x] GET/DELETE bundle — list/delete migrated; empty GET list returns `[]`
- [x] POST channel — create/update/set migrated; download-channel defaults now HTTP
- [x] DELETE app — DB delete migrated; icon + legacy user storage cleanup now server-side

## Still on supabase-js (file references)

- `cli/src/api/channels.ts` — channel link reads for delete/unlink still PostgREST (preview keys lack `app.read_channels` on HTTP GET `/channel`)
- `cli/src/api/versions.ts` — `deleteAppVersion` soft-delete path still PostgREST when a supabase client is passed
- `cli/src/bundle/upload.ts` — RBAC/2FA/plan checks still use supabase client helpers; channel link reads for preview-key parity stay on HTTP where `app.read_channels` is available
