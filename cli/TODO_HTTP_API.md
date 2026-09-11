# CLI HTTP API migration TODOs

## Missing endpoints (block full supabase-js removal)

- [x] GET organization v7-enriched fields (`GET /private/cli/orgs` wraps `get_orgs_v7`)
- [x] Password policy / 2FA member status (`GET /private/cli/org-member-compliance`)
- [ ] POST organization via API key (JWT-only `middlewareAuth` today)
- [ ] Icon / storage uploads via Capgo HTTP (still supabase storage)
- [x] Channel-scoped current bundle HTTP that preserves `channel.read` RBAC (`GET /private/cli/channel-current-bundle`)
- [ ] PUT app fields still missing from HTTP: `allow_preview`, `build_timeout_seconds`, `default_upload_channel`
- [x] GET organization security fields (`enforcing_2fa`, `password_policy_config`, API-key policy flags)
- [ ] GET channel fields still missing from HTTP response: `ios`, `android`, `owner_org`
- [x] POST `bundle/prepare` — version upsert for CLI upload (`updateOrCreateVersion` → Capgo HTTP)
- [x] GET `bundle/lookup` — version existence / latest name for auto-bump
- [x] POST `private/finish_tus_upload` — set `r2_path` after TUS
- [x] POST/GET `private/cli/*` — permission, plan, warnings, 2FA, orgs, current bundle, user id
- [ ] Bundle compatibility `native_packages` dedicated endpoint (today via full GET bundle rows)
- [ ] User-scoped storage cleanup path `apps/${appId}/${userId}` on app delete

## Partial (endpoint exists, CLI still needs more)

- [x] GET organization — security settings now included in HTTP payload
- [x] GET organization/members — member list + 2FA/password enrichment via `/private/cli/org-member-compliance`
- [ ] PUT app — core settings migrated; preview/timeout/default upload channel still SDK
- [ ] GET channel — list/find migrated; display defaults ios/android to false
- [ ] GET/DELETE bundle — list/delete migrated; empty list currently returns API error that CLI maps to `[]`
- [ ] POST channel — create/update/set migrated; create no longer sends `created_by`/`owner_org` (server-owned)
- [ ] DELETE app — DB delete migrated; legacy user storage cleanup still SDK

## Still on supabase-js (file references)

CLI `src/` no longer calls `supabase.rpc`. Remaining supabase-js use is PostgREST/storage, not RPC:

- `cli/src/app/set.ts` — icon storage upload; `allow_preview` / `build_timeout_seconds` / `default_upload_channel`
- `cli/src/app/delete.ts` — user-scoped storage cleanup
- `cli/src/app/add.ts` — icon storage upload
- `cli/src/bundle/upload.ts` — AI auto-bump manifest fetch still uses supabase-js
- `cli/src/bundle/compatibility.ts` — native package reads when not using HTTP bundle payload
- `cli/src/bundle/unlink.ts` — `checkVersionNotUsedInChannel` still uses supabase-js PostgREST
- `cli/src/channel/set.ts` — `checkCompatibilityNativePackages` still needs supabase client
