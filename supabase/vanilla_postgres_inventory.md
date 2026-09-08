# Vanilla Postgres 17 migration inventory (Phase 0)

Phase 0 applies the existing `supabase/migrations/` tree to a plain `postgres:17`
container (`docker-compose.yml`) via the Supabase CLI:

```bash
bun run postgres:vanilla:up
bun run postgres:vanilla:push
```

This path is **additive**. `bun run supabase:start` remains the default local
development stack.

## Apply attempt (2026-09-08)

| Field | Value |
| --- | --- |
| Postgres image | `postgres:17-alpine` |
| CLI | `bunx supabase db push --db-url 'postgresql://postgres:postgres@127.0.0.1:5432/capgo?sslmode=disable'` |
| Migration files | 81 (`20260708000000_prod_baseline.sql` + 80 incrementals) |
| **First failure** | `20260708000000_prod_baseline.sql` |
| **First error** | `extension "pg_cron" is not available` |
| **Failed statement** | `CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog"` (statement 10) |
| Migrations applied before failure | 0 (baseline did not complete) |
| Log artifact | `.context/vanilla-postgres/db-push-phase0.log` (local; not committed) |

`sslmode=disable` is required for the compose Postgres URL; the Supabase CLI
defaults to TLS and fails with “The server does not support SSL connections”
otherwise.

## Categorized inventory

Static analysis of `supabase/migrations/*.sql` plus the failed apply. Items are
ordered roughly as they would block a vanilla apply after earlier blockers are
resolved.

### 1. Extensions (baseline `20260708000000_prod_baseline.sql`)

| Extension | Schema | Vanilla PG 17 | Notes |
| --- | --- | --- | --- |
| `pg_cron` | `pg_catalog` | **Blocks first** | Job scheduler; not in stock `postgres:17` image |
| `pg_net` | `extensions` | **Required** | Async HTTP from SQL; Supabase/platform image |
| `pgmq` | `pgmq` | **Required** | Queue extension; used across baseline + incrementals |
| `supabase_vault` | `vault` | **Required** | Secrets (`vault.decrypted_secrets`, `vault.secrets`) |
| `http` | `extensions` | Likely missing | Used with `net.http_post` patterns |
| `hypopg` | `extensions` | Optional dev | Hypothetical indexes |
| `index_advisor` | `extensions` | Optional dev | Query advisor |
| `moddatetime` | `extensions` | Often installable | `updated_at` triggers |
| `pg_stat_statements` | `extensions` | Usually available | May need `shared_preload_libraries` |
| `pg_tle` | default | Uncommon | Trusted Language Extensions |
| `plpgsql_check` | `extensions` | Optional dev | Linting |
| `pgcrypto` | `extensions` | **Usually OK** | Stock contrib module |

Dropped in baseline (harmless on vanilla): `pg_graphql`, `pg_stat_monitor`, `postgres_fdw`.

### 2. Auth schema and helpers (`auth.*`)

Not created by Capgo migrations; provided by GoTrue / Supabase Auth image.

| Dependency | Occurrences (approx.) | Example |
| --- | --- | --- |
| `auth.users` | baseline + incrementals | joins, deletes, signup hooks |
| `auth.mfa_factors` | baseline + MFA migrations | 2FA enforcement |
| `auth.uid()` | baseline-heavy | RLS, RBAC helpers |
| `auth.jwt()` | baseline-heavy | role / service_role checks |
| `auth.role()` | baseline | request role resolution |

**Incremental migrations** that assume `auth.*` without creating it include
`20260817175411_block_password_signup_sso.sql`,
`20260817175835_split_mfa_session_and_email_otp_checks.sql`, and many baseline
RLS policies.

### 3. Storage schema (`storage.*`)

Not created by Capgo migrations; provided by Supabase Storage.

| Object | Migrations | Notes |
| --- | --- | --- |
| `storage.objects` RLS policies | baseline, `20260723120547_fix_app_create_storage_rls.sql` | `images` / `apps` bucket paths |
| `storage.foldername()` | storage RLS policies | Supabase storage helper |

### 4. Roles and grants

Supabase platform roles expected but not created on vanilla Postgres:

| Role | Usage |
| --- | --- |
| `anon` | PostgREST / RLS policies, RPC `GRANT EXECUTE` |
| `authenticated` | JWT-authenticated RLS and RPC grants |
| `service_role` | privileged bypass in functions and grants |
| `supabase_admin` | internal admin bypass arrays |
| `supabase_auth_admin` | GoTrue hook execution (`hook_*` grants) |
| `supabase_storage_admin` | storage bypass in audit helpers |
| `supabase_realtime_admin` | listed in privileged session_user checks |

Baseline alone has **~170** `GRANT ... TO anon|authenticated|service_role` statements.
Incrementals add more (e.g. `20260715213729_app_preview_api_key_role.sql`).

Hook migrations grant to `supabase_auth_admin` only when the role exists
(`IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin')`).

### 5. GoTrue auth hooks

| Function | Migration | Purpose |
| --- | --- | --- |
| `public.hook_before_user_created` | `20260817175411_block_password_signup_sso.sql` | Block password signup when SSO-only |
| `public.hook_send_email` | `20260820101459_auth_send_email_hook_queue.sql` | Enqueue auth emails via `pgmq` |

Both require GoTrue to call them and `supabase_auth_admin` execute grants.

### 6. Queues and cron (`pgmq`, `pg_cron`, `net`)

| Mechanism | Baseline | Incrementals (examples) |
| --- | --- | --- |
| `pgmq.create(...)` | yes | `global_stats_creates`, `send_email`, `on_user_org_access`, … |
| `pgmq.send(...)` | yes | webhooks, cron dispatch, auth email queue |
| `cron.schedule(...)` | yes | `20260715213729_app_preview_api_key_role.sql` |
| `net.http_post(...)` | yes | edge function / worker dispatch from SQL |

Queue names touched in migrations include (non-exhaustive): `admin_stats`,
`cron_email`, `send_email`, `global_stats_creates`, `on_user_org_access`,
`canceled_org_retention_alerts`, `cron_app_fame`, and cron-task-driven queues
registered in `cron_tasks`.

### 7. Vault secrets

| Pattern | Migration |
| --- | --- |
| `vault.decrypted_secrets` reads | baseline (`apikey`, `db_url`, runtime config) |
| `DELETE FROM vault.secrets` | `20260820090539_remove_rbac_global_flag.sql` |

Requires `supabase_vault` extension and seeded secrets (normally platform-managed).

### 8. Other Supabase-platform assumptions

- **`extensions` schema** — baseline installs multiple extensions into `extensions`.
- **PostgREST request GUCs** — `request.headers`, `capgkey` header helpers (via Supabase API layer).
- **Realtime / GraphQL** — `pg_graphql` dropped in baseline; realtime not migrated but admin roles referenced.

## What likely works without changes

After stubbing or replacing the blockers above, much of `public.*` (tables, RBAC,
business logic) is plain PostgreSQL. Phase 0 intentionally does **not** stub those
pieces; it documents dependencies before any auth cutover or PlanetScale work.

## Next phases (out of scope for Phase 0)

- Do not change auth or adopt better-auth in Phase 0.
- Do not modify PlanetScale / replica paths.
- Prefer additive compatibility shims or separate bootstrap SQL over editing the
  squashed baseline until a deliberate migration strategy is chosen.

## Reproduce locally

```bash
bun run postgres:vanilla:up
bun run postgres:vanilla:push   # expect failure at pg_cron on fresh DB
```

Fresh database:

```bash
bun run postgres:vanilla:down
docker volume rm workspace_capgo_vanilla_postgres_data 2>/dev/null || true
bun run postgres:vanilla:up
bun run postgres:vanilla:push
```
