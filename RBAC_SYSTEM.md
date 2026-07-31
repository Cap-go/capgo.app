# Capgo RBAC System

Capgo authorization is RBAC-only.

The old API-key mode system and old org membership rights are removed from the
current schema. Do not add code, RLS policies, tests, or docs that authorize from
API-key `read`/`upload`/`write`/`all` modes or from `org_users` rights.

## Source Of Truth

Authorization is based on these tables:

- `roles`
- `permissions`
- `role_permissions`
- `role_bindings`

`org_users` is membership/profile metadata only. It can store the display role
name used by product flows, but it must not grant access. If a user has an
`org_users` row and no matching `role_bindings`, authorization must deny.

API keys authorize through `role_bindings` with `principal_type = 'apikey'`.
Users authorize through `role_bindings` with `principal_type = 'user'`.

## Permission Checks

Backend code should check explicit permission keys such as:

- `org.manage_members`
- `org.manage_settings`
- `app.read`
- `app.upload_bundle`
- `app.update_settings`
- `channel.promote_bundle`

Use the current RBAC helpers:

- `rbac_check_permission_request(permission_key, org_id, app_id, channel_id)`
- `rbac_check_permission(permission_key, org_id, app_id, channel_id)`
- `rbac_check_permission_direct(permission_key, user_id, org_id, app_id, channel_id, apikey)`

Do not reintroduce helpers that map minimum rights or API-key modes to
permissions.

## RLS Rules

RLS policies must call RBAC permission helpers directly and must stay bounded by
the protected row's indexed scope columns.

For tables with an `app_id`, pass the row's `owner_org` and `app_id` into the
RBAC check. For tables without `app_id`, join through the closest indexed parent
that provides the app or org scope. Do not precompute broad visibility lists by
scanning all apps, versions, channels, or org resources.

Direct client mutation of privilege-bearing tables must be denied unless there
is a narrow RBAC policy for the exact action. API-key traffic must never update
API-key rows, role bindings, roles, role permissions, org membership metadata,
or other privilege state.

## Removed System

The old API-key mode system, minimum-right helper family, org-level RBAC switch,
and org membership rights columns are deleted from the current schema and must
stay deleted.

The regression tests in `supabase/tests/26_test_rls_policies.sql` and
`tests/security-definer-execute-hardening.test.ts` assert the exact final-state
object list.
