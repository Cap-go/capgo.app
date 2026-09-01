# Test user matrix

Legend: R = reads user records only (no direct auth/public users writes detected); W = writes user records (create/update/delete/SQL).

| Test file | Users | User ops (R/W) | Parallel compatibility |
| --- | --- | --- | --- |
| tests/admin-credits.test.ts | USER_ID | R | Shared |
| tests/apikeys-expiration.test.ts | USER_ID_APIKEY_EXPIRATION | R | Isolated |
| tests/app-id-validation.test.ts | USER_ID | R | Shared |
| tests/app-permissions.test.ts | USER_ID, USER_ID_2 | R | Shared |
| tests/app.test.ts | USER_ID | R | Shared |
| tests/audit-logs.test.ts | USER_ID | R | Shared |
| tests/build_time_tracking.test.ts | USER_ID | R | Shared |
| tests/bundle-create.test.ts | USER_ID | R | Shared |
| tests/bundle-error-cases.test.ts | USER_ID | R | Shared |
| tests/bundle-semver-validation.test.ts | USER_ID | R | Shared |
| tests/channel_devices/channel_deletion.test.ts | USER_ID | R | Shared |
| tests/channel_devices/channel_self_delete.test.ts | USER_ID | R | Shared |
| tests/cli-compat.test.ts | USER_ID | R | Shared |
| tests/cli-channel.test.ts | USER_ID | R | Shared |
| tests/cli-hashed-apikey.test.ts | USER_ID, USER_ID_RLS | R | Shared |
| tests/cli-s3.test.ts | USER_ID | R | Shared |
| tests/cli.test.ts | USER_ID | R | Shared |
| tests/cron_stat_integration.test.ts | USER_ID | R | Shared |
| tests/cron_stat_org.test.ts | USER_ID | R | Shared |
| tests/delete-user-reauth.test.ts | USER_ID, USER_ID_DELETE_USER_STALE, USER_ID_DELETE_USER_FRESH, USER_EMAIL_DELETE_USER_FRESH, USER_EMAIL | R | Shared |
| tests/email-preferences.test.ts | USER_ID_EMAIL_PREFS, USER_EMAIL_EMAIL_PREFS | W | Isolated |
| tests/enforce-encrypted-bundles.test.ts | USER_ID, USER_ID_ENCRYPTED | R | Shared |
| tests/hashed-apikey-rls.test.ts | USER_ID, USER_ID_RLS | R | Shared |
| tests/organization-api.test.ts | USER_ID, USER_EMAIL, USER_ADMIN_EMAIL | R | Shared |
| tests/password-policy.test.ts | USER_ID, USER_ID_2, USER_EMAIL, USER_PASSWORD, USER_PASSWORD_HASH | W | Shared |
| tests/private-error-cases.test.ts | USER_ID | R | Shared |
| tests/rbac-permissions.test.ts | USER_ID | R | Shared |
| tests/trigger-error-cases.test.ts | USER_EMAIL | R | Shared |
| tests/webhook-signature.test.ts | USER_ID | R | Shared |
| tests/webhooks.test.ts | USER_ID | R | Shared |

Notes:
- “Parallel compatibility” is a heuristic: “Isolated” means only dedicated users or single-use users detected; “Shared” means users are reused across multiple tests.
- If a test writes to auth/public users, it should use dedicated users or cleanup per test to be safe in parallel runs.
