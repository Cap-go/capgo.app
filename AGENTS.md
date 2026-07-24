# AGENTS.md

This file provides guidance to AI agents (Claude Code, Cursor, Copilot, etc.)
when working with code in this repository.

## Essential Development Commands

### Building and Development

- `bun serve:dev` - Start local development server with local environment
- `bun serve` - Start development server with default configuration
- `bun build` - Build production version of the web app
- `bun mobile` - Build for mobile and copy to Capacitor platforms
- `bun dev-build` - Build with development branch configuration
- `bun run cli:build` - Build the CLI workspace in `cli/`
- `bun run cli:test` - Run the CLI workspace test suite
- `bun run cli:check` - Lint, typecheck, build, and test the CLI workspace

### Testing

#### Supabase Edge Functions (Default)

- `bun test:all` - Run all backend tests
- `bun test:unit` - Run unit tests only (`tests/*.unit.test.ts`, no Supabase or
  Docker required)
- `bun test:db` - Run the DB-only test subset listed in
  `tests/tinbase-db-tests.txt` against a throwaway Tinbase instance (no Docker;
  boots in ~5s). Add a test file to that list only if it talks purely to
  PostgREST/auth via supabase-js — no edge functions, Cloudflare workers, or raw
  Postgres TCP (`executeSQL`/`getPostgresClient`)
- `bun test:backend:integration` - Run backend tests excluding unit and CLI
  tests (requires running Supabase; this is what CI shards across runners; CLI
  integration tests run via `bun test:cli`)
- `bun test:backend` - Run backend tests excluding CLI tests
- `bun test:cli` - Run CLI-specific tests
- `bun test:local` - Legacy alias for the default monorepo backend test run
- `bun test:front` - Run Playwright frontend tests
- `bun test:all:local` - Legacy alias for `bun test:all`
- `bun test:cli:local` - Legacy alias for `bun test:cli`

#### Cloudflare Workers Testing

- `bun test:cloudflare:all` - Run all tests against Cloudflare Workers
- `bun test:cloudflare:backend` - Run backend tests against Cloudflare Workers
- `bun test:cloudflare:updates` - Run update tests against Cloudflare Workers
- `./scripts/start-cloudflare-workers.sh` - Start local Cloudflare Workers for
  testing

Note: Prefer Tinbase (`bun test:db` / `tests/tinbase-db-tests.txt`) for
PostgREST/auth-only coverage so Docker/Cloudflare shards stay small and can
run at high concurrency. CI caps every test job at 5 minutes and shards
backend/Cloudflare/Playwright aggressively instead of lowering concurrency.

See [CLOUDFLARE_TESTING.md](CLOUDFLARE_TESTING.md) for detailed information on
testing against Cloudflare Workers.

### Code Quality

- `bun lint` - Lint Vue, TypeScript, and JavaScript files
- `bun lint:fix` - Auto-fix linting issues
- `bun lint:backend` - Lint Supabase backend files
- `bun typecheck` - Run TypeScript type checking with vue-tsc
- `bun types` - Generate TypeScript types from Supabase

### Database and Backend

- `bun run supabase:start` - Start local Supabase instance (worktree-isolated)
- `bun run supabase:cleanup` - Stop local Supabase and delete this worktree's Supabase volumes
- `bun run supabase:db:reset` - Reset and seed local database
- `bun backend` - Start Supabase functions locally
- `bun reset` - Reset Supabase database

## Architecture Overview

### Frontend Architecture

- **Framework**: Vue 3 with Composition API and `<script setup>` syntax
- **Build Tool**: Vite with custom Rolldown integration
- **Routing**: File-based routing with unplugin-vue-router
- **State Management**: Pinia stores
- **Styling**: TailwindCSS with DaisyUI components
- **Mobile**: Capacitor for native mobile functionality

### Backend Architecture

- **Database**: PostgreSQL via Supabase
- **Edge Functions**: Supabase Edge Functions (Deno runtime)
- **API Deployment**: Multi-platform deployment:
  - Cloudflare Workers (primary, handles 99% of traffic)
  - Supabase Functions (internal tasks, CRON jobs)

### Key Backend Components

- **`supabase/functions/_backend/`** - Core backend logic
  - `plugins/` - Public plugin endpoints (updates, stats, channel_self)
  - `private/` - Internal API endpoints (auth required)
  - `public/` - Public API endpoints (app, bundle, device management)
  - `triggers/` - Database triggers and CRON functions
  - `utils/` - Shared utilities and database schemas

### Production Scale Guardrails

Capgo production data is large enough that "small queue" designs are
incorrect by default. Before changing queue, storage, manifest, cron, or
backfill code, design for this scale:

- `manifest` has millions of rows, and operational scripts can need to scan or
  repair millions of records.
- Plugin endpoints serve roughly 2M to 50M device requests per day. Anything
  used by `/updates`, `/stats`, `/channel_self`, or other plugin traffic must be
  designed as a hot path first.
- Plugin endpoints must never use the primary Supabase/Postgres database in the
  request path. Design plugin-facing systems around replicated data, edge
  caches, durable queues, or precomputed state that can survive this traffic
  level without primary database fan-out.
- The web console has a much smaller frontend audience, usually around 500 to
  1k end users, so raw UI request scale is less often the bottleneck. Do not
  apply console-scale assumptions to plugins, bundle processing, storage, or
  automation systems.
- A normal app bundle can contain thousands of files; 5k files in one bundle is
  expected, not an edge case.
- Bundles and automation paths must be solid at backend scale. Audit logs and
  manifest-related datasets can each be multiple GB, so scripts, jobs, and
  queries must be bounded and resumable.
- R2 storage is at TB scale. Do not download objects locally for copy, repair,
  size, or migration jobs when the provider supports server-side operations.
- Manifest size work must handle large batches. A design that only processes
  `100` files every `10` seconds is not acceptable for manifest-size backfills,
  per-bundle processing, or upload finalization.
- Queue consumers must be sized from measured throughput: batch size,
  concurrency, visibility timeout, retry count, provider/API limits, and caller
  timeout must all fit the same worst-case calculation.
- Do not assume a `202` HTTP response means queue work finished. If the handler
  uses background work, prove the work can finish inside the runtime limits and
  that successful queue messages are deleted before visibility timeout expires.
- For high-volume internal queue dispatch, avoid routing through unstable or
  low-timeout paths. Use the production Cloudflare path when that is the runtime
  intended to handle the traffic, and make database `pg_net` timeouts match the
  real batch duration.
- For data repair scripts, use indexed pagination over the owning table's key
  path, keep DB writes batched, make work resumable, and write failed records to
  a report file for later inspection.
- GUESS IS NOT AN OPTION for production scale failures. Find the exact
  production evidence in database state, queue/archive tables, provider logs, or
  HTTP/runtime logs. If the current logs cannot identify the cause, first add
  logging that will identify it in the next occurrence.

### AI Workflow Notes

- **Hono v4 HEAD routing:** do not add HEAD routes with `app.on`. Hono v4 removed `app.head()` because `GET` handlers implicitly serve `HEAD`; keep shared GET/HEAD logic in the `app.get(...)` handler and branch on `c.req.raw.method` only when the behavior must differ.

- For understanding the **current DB schema**, prefer
  `supabase/schemas/prod.sql` (schema dump) instead of scanning all migrations.
- For **schema changes**, always edit or add files under
  `supabase/migrations/` and treat `supabase/schemas/prod.sql` as read-only
  reference.
  - Migration files must be created via CLI only.
  - Never create migration files manually.
  - Always use `bunx supabase migration new <feature_slug>`.
  - Manual creation of migration files is not allowed.
- **Supabase admin client + sign-in pitfall:** if you call
  `supabaseAdmin.auth.signInWithPassword(...)`, that client becomes authenticated
  as the user (it is no longer a pure service-role client). Always use a
  **separate admin client** for sign-in, and keep a clean admin client for
  service-role writes. Example:
  - `const loginAdmin = supabaseAdmin(c)` → use for `signInWithPassword`
  - `const adminClient = supabaseAdmin(c)` → use for admin writes
- **Backend DB access style:** prefer `getPgClient()` / `getDrizzleClient()` for
  multi-step SQL, transactions, joins, schema-backed writes, or code that
  benefits from explicit pool lifecycle handling. Do **not** force every simple
  one-statement internal helper write into Drizzle just for consistency. A
  small service-role helper that is already a single clear `supabaseAdmin(c)`
  call may stay on `supabaseAdmin` when that keeps the code smaller and equally
  correct.

### HTTP Response Conventions

All API endpoints must follow these response patterns:

- **Success with data:** `return c.json(data)` or `return c.json(data, 200)`
- **Success without data:** `return c.json(BRES)` where `BRES = { status: 'ok' }` (import
  from `utils/hono.ts`)
- **Errors:** Use `return simpleError()` or `return quickError(status, ...)` (import from
  `utils/hono.ts`)

Do NOT use `c.body(null, 204)` for success responses. Always return JSON for consistency.

### Cache System (On-Prem + Plan Upgrade)

Capgo relies on two layered caches for plugin endpoints (`/updates`, `/stats`, `/channel_self`) and they depend on specific response codes/body shapes. Do **not** change these without updating the Cloudflare snippet + app status logic.

- **Edge on-prem cache (Cloudflare Snippet)**: `cloudflare_workers/snippet/index.js` caches responses when it detects:
  - `429` + `{ error: 'on_premise_app' }` (from `/updates` or `/channel_self`), or
  - `{ isOnprem: true }` (from `/stats`).
    The snippet stores cached responses using the worker's `Cache-Control` TTL and serves them before routing.
- **Edge plan-upgrade cache (Cloudflare Snippet)**: same file caches responses when it detects:
  - `429` + `{ error: 'need_plan_upgrade' }`.
- **App status cache (Worker runtime)**: `supabase/functions/_backend/utils/appStatus.ts` stores `onprem` / `cancelled` / `cloud` for 60s using the Cache API to short-circuit DB lookups.

**Implication:** Keep the `429` + error payloads for on-prem and plan-upgrade responses; otherwise the edge caches and status cache effectiveness are broken.

### Key Frontend Directories

- **`src/components/`** - Reusable Vue components
- **`src/pages/`** - File-based route pages
- **`src/services/`** - API clients and external service integrations
- **`src/stores/`** - Pinia state management stores
- **`src/layouts/`** - Page layout components

## Development Environment

### Required Tools

- **Bun** - Package manager and JavaScript runtime
- **Docker** - Required for Supabase local development
- **Supabase CLI** - Database and functions management

### Command phrasing

1. Front-facing instructions (docs, onboarding, tooltips, demos, and customer-facing help):
   - Use `npx` for runnable command examples and keep `npx` in those public snippets.
   - Do not mention internal execution tooling preferences in this customer-facing context.

2. Internal tooling and internal documentation:
   - Prefer Bun tooling (`bun`/`bunx`) for repository maintenance, scripts, and internal workflows.

3. Capgo CLI references:
   - When explicitly discussing the Capgo CLI command itself, always use `@latest`.
   - Use the public shape like `npx @capgo/cli@latest ...` for customer-facing command examples.
   - Use internal execution equivalents (for example, `bunx @capgo/cli@latest ...`) only in internal tooling context.
   - CLI command names must be lowercase and should use kebab-case for multiple words. Do not add camelCase, PascalCase, or other cased command names.

### Email Templates

- `supabase/templates/invite_new_user_to_org.html` and `supabase/templates/invite_existing_user_to_org.html` are Bento templates.
- Every other file in `supabase/templates/` is a Supabase auth or notification template.
- Supabase templates use Supabase template syntax.
- Bento templates use Bento template syntax.
- Updating templates in the repository does not upload them anywhere automatically.
- Supabase email templates must be uploaded manually to Supabase.
- Bento email templates must be uploaded manually to Bento.

### Environment Setup

1. Install dependencies: `bun install`
2. Start Supabase: `bun run supabase:start`
3. Reset database with seed data: `bun run supabase:db:reset`
4. Start frontend: `bun serve:dev`

### Test Accounts (Local Development)

- Demo User: `test@capgo.app` / `testtest`
- Admin User: `admin@capgo.app` / `adminadmin`

## Testing Strategy

### Backend Tests

- Located in `tests/` directory
- Use Vitest test runner with custom configuration
- Require running Supabase instance
- Tests modify local database state
- Capgo CLI tests resolve the local `cli/` workspace by default in this monorepo

### Test Categories

- API endpoint tests (CRUD operations)
- CLI functionality tests
- Database trigger tests
- Integration tests with external services

### CRITICAL: Test Isolation for Parallel Execution

**ALL TEST FILES RUN IN PARALLEL.** Tests within the same file run sequentially (unless explicitly configured otherwise), but different test files execute simultaneously. You MUST design tests accordingly.

**Maximize parallelism:** Use `it.concurrent()` instead of `it()` when possible, to run tests in parallel within the same file. More parallel tests = faster CI/CD.

When creating tests that interact with shared resources (users, apps, orgs, devices, channels, bundles, etc.), follow these rules:

**You CAN reuse existing seed data IF:**

- You only READ the data, not modify it
- You create your OWN child resources under it (e.g., reuse a user but create your own app/org for that user)
- The parent resource is not modified by your test or other tests

**You MUST create dedicated seed data IF:**

- Your test MODIFIES the resource (update, delete, change settings)
- Other tests also modify that same resource
- The resource state matters for your test assertions

**Guidelines:**

1. **Create dedicated seed data when needed** - Add new test-specific entries in `supabase/seed.sql` with unique identifiers
2. **Use unique naming conventions** - Prefix test data with the test file name or feature being tested (e.g., `test_my_feature_user@capgo.app`, `com.test.myfeature.app`)
3. **Clean up is NOT enough** - Even with cleanup, parallel test files might try to use the data simultaneously

**Examples of what breaks parallel test files:**

- Modifying the default `test@capgo.app` user's settings
- Deleting or updating the default app `com.demo.app`
- Changing org settings on the shared test org
- Using hardcoded IDs that other test files also modify

**Examples of safe reuse:**

- Using `test@capgo.app` to create a NEW app specific to your test (user is not modified)
- Reading from shared orgs without modifying them
- Creating new channels/bundles under your own dedicated app

**When you need isolation, create dedicated seed data:**

```sql
-- In seed.sql, add dedicated test data for your test file:
INSERT INTO auth.users (id, email, ...) VALUES
  ('unique-uuid-for-my-test', 'my_feature_test@capgo.app', ...);
INSERT INTO public.apps (app_id, owner_org, ...) VALUES
  ('com.test.myfeature.app', 'my-test-org-id', ...);
```

Then in your test file, use ONLY these dedicated resources for modifications.

**If your test breaks other tests in CI/CD, it is YOUR responsibility to fix it by creating isolated seed data.**

## Code Style and Conventions

### ESLint Configuration

- Uses `@antfu/eslint-config` with custom rules
- Single quotes, no semicolons
- Vue 3 Composition API preferred
- Ignores: dist, scripts, public, supabase generated files

### TypeScript

- Strict mode enabled
- Path aliases: `~/` maps to `src/`
- Auto-generated types for Vue components and routes
- Supabase types auto-generated via CLI

### Comments

- All code comments must be in English, regardless of the chat language.

### Translations

- Never pass inline fallback text as the second argument to translation calls such as `t('key', 'English text')`.
- Always use translation keys only, for example `t('key')`.
- When text is missing, add or update the key in `messages/en.json` instead of putting English fallback text in code.

### Commit Messages

- Follow Conventional Commits v1.0.0 (<https://www.conventionalcommits.org/en/v1.0.0/>).
- Use a clear type and scope when helpful (e.g., `docs: ...`, `feat(api): ...`, `fix(frontend): ...`).

## Supabase Best Practices

- Always cover database changes with Postgres-level tests and complement them
  with end-to-end tests for affected user flows.
- Use the Supabase CLI for every migration and operational task whenever
  possible; avoid manual changes through the dashboard or direct SQL.
- When a feature requires schema changes, create a single migration file with
  the Supabase CLI (`bunx supabase migration new <feature_slug>`) and keep editing
  that file until the feature ships; never edit previously committed migrations.
- If a migration file is newly created and not yet committed, it may be modified.
- Keep amending the same migration file while the pull request is still open.
- Never create a second migration file for the same schema change set. If not yet merged, do not split work into multiple migration files for one change.
- Use CLI for migrations. Never manually create migration files.
- Updating `supabase/seed.sql` to back new or evolved tests is expected; keep
  fixtures focused on current behavior while leaving committed migrations
  unchanged.
- A migration that introduces a new table may include seed inserts for that
  table, but treat that seeding as part of the current feature and do not modify
  previously committed migrations.
- Investigate failing Supabase tests by reviewing the Docker container logs and
  any other relevant service logs before retrying.
- Before validating any backend or frontend task, run the project lint/format
  command to ensure consistent formatting.
- Leave `CHANGELOG.md` entries and the `version` field in `package.json` to the
  release automation; CI/CD updates them during tagged releases.
- Do not create new cron jobs it's bad pattern instead update
  process_all_cron_tasks function in a new migration file to add your job if
  needed.
- For runtime feature flags and security-related toggles, use runtime config from
  Vault-backed settings and avoid mutable singleton tables in application code.
- Do not store environment-driven behavior in singleton tables.
- Use Vault-backed configuration values as the source of truth and runtime
  environment values only for deployment-time overrides.
- Never use the Supabase admin SDK (with service key) for user-facing APIs.
  Always use the client SDK with user authentication so RLS policies are
  enforced. The admin SDK should only be used when accessing data that is not
  user-accessible or for internal operations (triggers, CRON jobs, etc.). When
  admin access is unavoidable for a user-facing endpoint, sanitize all user
  inputs carefully—the SDK is susceptible to PostgREST query injection (not SQL
  injection, but filter/modifier injection via crafted parameters).
- Prefer claim-based auth lookups for performance: use
  `supabase.auth.getClaims()` (frontend) or auth context from middleware
  (backend) instead of `getUser()` unless you explicitly need the full user
  record from the Auth API.

### PostgreSQL Extension Policy

- Avoid introducing new PostgreSQL extensions if an existing feature or SQL
  approach can solve the same requirement.
- If an extension is truly unavoidable, add it only with explicit user
  consent and never by default.
- If there is no practical alternative, add a migration with a clear fallback plan.
- Never enable a new PostgreSQL extension without explicit user consent before
  applying it.

### PostgreSQL Function Security

**ALWAYS set an empty search path in every PostgreSQL function.**

Every function must set `search_path = ''` and use fully qualified names for all references:

```sql
-- CORRECT: Empty search_path with fully qualified names
CREATE OR REPLACE FUNCTION "public"."my_function"()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    SELECT * FROM "public"."my_table";
    -- All table/type references must be fully qualified
END;
$$;

-- WRONG: Missing search_path - vulnerable to attacks
CREATE OR REPLACE FUNCTION public.my_function()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    SELECT * FROM my_table;
END;
$$;
```

### PostgreSQL Function Scalability Gate (CRITICAL)

Every PostgreSQL function call added to a policy, view, trigger, RPC,
PostgREST-exposed query path, or hot backend endpoint must be proven to scale
before it ships. Treat this as mandatory for RLS helpers such as
`rbac_check_permission_request`, `rbac_check_permission`, and any new wrapper
around them.

Before adding or changing a function call, document the execution model:

- Where the function runs: RLS `USING` / `WITH CHECK`, SQL view, trigger, RPC,
  backend query, or plugin endpoint.
- How often it can run: once per statement, once per request, once per row, or
  once per candidate row from another table.
- Which roles can reach it: `anon`, `authenticated`, `service_role`, API key, or
  public PostgREST traffic.
- The production cardinality of every table it touches, using
  `supabase/schemas/prod.sql`, production estimates, or staging data with
  production-like row counts.
- The exact indexes expected to bound each lookup.

RLS function calls are dangerous by default:

- Assume every function inside an RLS policy can run per row unless
  `EXPLAIN (ANALYZE, BUFFERS)` proves otherwise.
- Never fix an unbounded table scan by adding an "allowed ids" helper that scans
  another large table. Allowed-list helpers are only acceptable when they start
  from caller-scoped, indexed identity data and stay bounded before touching the
  protected resource.
- Never create a helper that scans a broad production table and calls RBAC
  checks, API-key checks, logging, or other SQL functions once per scanned row.
- If a table has `app_id`, prefer a policy shape that constrains by that
  row's indexed `app_id`/`owner_org` values. Do not precompute visibility by
  scanning all apps, all versions, all channels, or all org resources.

Before opening a PR with a PostgreSQL function or RLS policy change, run and
paste the relevant `EXPLAIN (ANALYZE, BUFFERS)` summary in the PR notes for the
worst cases:

- Public `anon` request with no auth and no API key.
- Invalid API key.
- Valid API key with broad access.
- Authenticated user with many orgs/apps.
- Unfiltered PostgREST query with `limit=1`.
- Filtered control query on the normal indexed filter path.
- At least 8 parallel unfiltered requests plus an unrelated lightweight query
  such as `/orgs?select=id&limit=1`.

The plan must show bounded index lookups, stable latency, and no sequential scan
over large production tables. Nested loops are acceptable only when the outer
side is already bounded and the inner side uses indexes. If production-scale
testing is not possible, choose the conservative safer design: deny or restrict
the path, require an indexed filter, split the endpoint, or ask for review
before shipping. Do not guess.

### PostgreSQL Function Permissioning (Least Privilege)

For RPCs and helper functions, apply minimum privileges explicitly:

- Start from deny-by-default and grant only required roles.
- Set `OWNER` explicitly for each new function.
- Use `REVOKE ALL ... FROM PUBLIC` to prevent public access drift from default ACLs.
- If `uuid`-based checks exist, do not grant `anon` or `authenticated` unless there is a strict user-facing requirement.
- Prefer granting only `service_role` for `uuid` overloads and keep user-context variants (`()`) on authenticated access only where needed.

### PostgreSQL RPC Data Exposure

Prevent RPCs from becoming an oracle system.

- Do not expose RPCs that let unauthorized users infer whether sensitive data exists, matches, or belongs to another user or org.
- Default to denying access unless the caller already has the rights required to read the underlying data through the normal permission model.
- If an RPC returns data, metadata, booleans, counts, or different error shapes, treat all of those as potential data leaks and gate them the same way.
- Never use a publicly callable RPC to answer sensitive existence checks, membership checks, entitlement checks, or status checks for records the caller cannot already access.
- Only allow broader access when the information is genuinely non-critical and the UX benefit is material.
- In that exceptional case, add an English code comment directly next to the function, endpoint, or policy explaining why the exposure is acceptable, what is intentionally revealed, and why restricting it would significantly harm UX.

### SQL FUNCTION SECURITY (UPPERCASE RULES)

WHEN ADDING AN ADMIN/PLATFORM-RBAC CHECK FUNCTION:

- DEFINE ONE SERVICE-ROLE-ONLY `uuid` OVERLOAD FOR INTERNAL LOOKUPS.
- DEFINE ONE USER-CONTEXT `()` OVERLOAD FOR CLIENT USAGE.
- APPLY `REVOKE ALL ... FROM PUBLIC` TO EVERY OVERLOAD.
- GRANT `service_role` TO `uuid` ONLY; GRANT `authenticated` ONLY TO `()` IF NEEDED.
- KEEP `SET search_path = ''` AND `SECURITY DEFINER` EXPLICIT.
- COMMENT THE BEHAVIOR (E.G., LEGACY VS PLATFORM SECRET CHECK) TO PREVENT REGRSSION.

```sql
ALTER FUNCTION public.is_platform_admin(userid uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.is_platform_admin(userid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_platform_admin(userid uuid) TO "service_role";
```

### Platform Admin Guardrails

Platform admin is **NOT** a general-purpose superuser capability.

- The only allowed platform-admin user action is spoofing/impersonating another
  user.
- The admin dashboard must stay read-only and limited to admin statistics,
  observability, and similar reporting.
- Never build a platform-admin write path that can change org membership, RBAC
  bindings, roles, permissions, billing state, app ownership, or any other
  privilege-bearing state.
- Never use platform admin as a shortcut around normal auth/RLS for mutating
  APIs. If an action could cause privilege elevation, do not expose it behind
  platform admin.
- Platform admins are defined from runtime Vault-backed configuration, not from
  mutable database state.
- There must be no API, UI, or database path to grant/revoke platform admin
  dynamically. The only supported way to change platform admins is to publish a
  new runtime version with updated environment configuration.
- If a privileged operational action is needed beyond impersonation or reading
  admin stats, implement it as a strictly internal service-role-only path, not
  as a platform-admin feature.

### RLS Policy Optimization Rules

**Rule 1: One policy per table per operation.**

Never create duplicate policies for the same operation on a table. Multiple policies on the same operation create OR conditions that hurt query performance. Merge all conditions into a single policy:

```sql
-- WRONG: Multiple SELECT policies on the same table
CREATE POLICY "policy_1" ON public.my_table FOR SELECT USING (condition_1);
CREATE POLICY "policy_2" ON public.my_table FOR SELECT USING (condition_2);

-- CORRECT: Single merged policy
CREATE POLICY "Allow select on my_table" ON public.my_table
FOR SELECT USING (condition_1 OR condition_2);
```

**Rule 1.5: Never rely on implicit deny for table operations.**

If an operation is intentionally forbidden, add an explicit deny policy for that
operation instead of relying on the absence of a policy.

- Do not use "no INSERT policy means INSERT is blocked" as the final design.
- Do not use "no DELETE policy means DELETE is blocked" as the final design.
- The expected repository style is explicit allow or explicit deny for each
  operation you intentionally care about.
- This is especially important for security-sensitive tables and system-managed
  tables such as `manifest`.

When an operation must be impossible for user-facing roles, prefer an explicit
deny policy with a clear name, for example:

```sql
-- Example: system-managed table, users must never insert rows directly
CREATE POLICY "Deny insert on my_table"
ON public.my_table
AS RESTRICTIVE
FOR INSERT
TO authenticated
WITH CHECK (false);

-- Example: users must never delete rows directly
CREATE POLICY "Deny delete on my_table"
ON public.my_table
AS RESTRICTIVE
FOR DELETE
TO authenticated
USING (false);
```

If API key traffic must also be denied through user-context RLS, make that
intent explicit in the policy design and naming. Do not leave the operation
blocked only because no policy happened to exist.

**Rule 2: Call `auth.uid()` only once using a subquery.**

The `auth.uid()` function should never be called multiple times in a policy. Use a `SELECT *` subquery pattern to call it once and reference the result:

```sql
-- WRONG: Multiple auth.uid() calls - poor performance
CREATE POLICY "my_policy" ON public.my_table
FOR SELECT USING (
    user_id = auth.uid()
    OR owner_id = auth.uid()
    OR created_by = auth.uid()
);

-- CORRECT: Single auth.uid() call with subquery
CREATE POLICY "my_policy" ON public.my_table
FOR SELECT USING (
    (SELECT * FROM (SELECT auth.uid() AS uid) AS auth_check
     WHERE user_id = auth_check.uid
        OR owner_id = auth_check.uid
        OR created_by = auth_check.uid)
);

-- ALSO CORRECT: Using a CTE-style approach in the check
CREATE POLICY "my_policy" ON public.my_table
FOR SELECT USING (
    EXISTS (
        SELECT 1
        FROM (SELECT auth.uid() AS uid) AS auth_user
        WHERE my_table.user_id = auth_user.uid
           OR my_table.owner_id = auth_user.uid
    )
);
```

## Database RLS Policies

### RBAC Functions for RLS - CRITICAL RULES

**NEVER use deleted identity/min-right helpers in RLS policies.**

Authorization must use RBAC permission keys through the current helpers:

- `public.rbac_check_permission_request(permission_key, org_id, app_id, channel_id)`
- `public.rbac_check_permission(permission_key, org_id, app_id, channel_id)`
- `public.rbac_check_permission_direct(permission_key, user_id, org_id, app_id, channel_id, apikey)`

`org_users` is metadata only and must not grant rights. API keys must authorize
through `role_bindings` with `principal_type = public.rbac_principal_apikey()`.

When a table has `app_id`, pass the row's indexed `owner_org`/`org_id` and
`app_id` to the RBAC check. If a table has no `app_id`, join through the closest
indexed parent that provides the app or org scope.

### RLS Pattern Examples

```sql
-- CORRECT: Table has app_id - use row scope with RBAC permission key
CREATE POLICY "Allow org members to select build_requests"
ON public.build_requests
FOR SELECT
TO authenticated, anon
USING (
    public.rbac_check_permission_request(
        public.rbac_perm_app_read(),
        owner_org,
        app_id,
        NULL::bigint
    )
);

-- CORRECT: Table has no app_id but can JOIN to get it
CREATE POLICY "Allow org members to select daily_build_time"
ON public.daily_build_time
FOR SELECT
TO authenticated, anon
USING (
    EXISTS (
      SELECT 1 FROM public.apps
      WHERE apps.app_id = daily_build_time.app_id
        AND public.rbac_check_permission_request(
            public.rbac_perm_app_read(),
            apps.owner_org,
            apps.app_id,
            NULL::bigint
        )
    )
);

-- Table has no app scope, so use the row's org scope directly.
CREATE POLICY "Allow org members to select build_logs"
ON public.build_logs
FOR SELECT
TO authenticated, anon
USING (
    public.rbac_check_permission_request(
        public.rbac_perm_org_read(),
        org_id,
        NULL::character varying,
        NULL::bigint
    )
);
```

Key points:

- Use both `authenticated` and `anon` roles where API-key traffic must reach the
  policy.
- API-key access must still resolve through RBAC `role_bindings`; do not inspect
  key modes.
- Reference apps, channels, app_versions, and manifest tables for current
  policy examples.

## Frontend Style

- The web client is built with Vue.js and Tailwind CSS; lean on utility classes
  and composition-friendly patterns rather than bespoke CSS.
- Use DaisyUI (`d-` prefixed classes) for buttons, inputs, and other interactive
  primitives to keep behavior and spacing consistent.
- Konsta components are reserved for the safe area helpers. Avoid importing
  `konsta` anywhere else in the app.
- Capgo's look centers on deep slate bases with the "Extract" azure highlight
  (`--color-azure-500: #119eff`) and soft radii; mirror the palette from
  `src/styles/style.css` (e.g., `--color-primary-500: #515271`) when introducing
  new UI.

### Form accessibility (WCAG 2.0 A)

SonarQube flags any `<input>`, `<select>`, or `<textarea>` without an associated
label. Treat this as a default requirement for every new or touched form control —
do not wait for the scanner to catch it later.

Every form control must have **one** of these associations before shipping:

1. **Visible label + `for`/`id`** — when label text is shown next to the field:
   ```vue
   <label for="field-id" class="label">...</label>
   <input id="field-id" ...>
   ```
2. **Wrapping `<label>`** — for radios, checkboxes, and toggle rows where the
   label already wraps the control.
3. **`sr-only` label + matching `id`** — for search/icon-only fields that only
   show a placeholder:
   ```vue
   <label for="search-id" class="sr-only">{{ t('search') }}</label>
   <input id="search-id" :aria-label="t('search')" ...>
   ```
4. **`aria-label`** — acceptable alongside (1) or (3); required when the only
   cue is placeholder text.

Reusable components must generate stable ids (`useId()` or an `inputId` prop) and
expose accessible names by default. Follow `SearchInput.vue` and `RoleSelect.vue`.

Also applies to dialog/Teleport content, admin filters, and hidden utility inputs
(e.g. file pickers): they still need `aria-label` or an associated label.


## Auth Redirect Guardrails

- We intentionally route auth email links through `/confirm-signup` to avoid
  mailbox link prefetchers triggering Supabase verification/recovery links.
- `confirm-signup.vue` only allows redirects to the console host and the
  Supabase host; if you change `VITE_APP_URL` or `VITE_SUPABASE_URL`, update
  both allow-lists accordingly.

## Frontend Testing

- Cover customer-facing flows with the Playwright suite under `playwright/e2e`
  and run them locally with `bun run test:front` before shipping UI changes.
  CI runs Playwright sharded with a 5-minute job budget.

### Visual diff for UI changes

When a PR changes customer-facing UI (layout, spacing, colors, components, or
copy placement), reviewers need a before/after screenshot diff.

**Request the automated PR report** by either:

- adding the `visual-change` label to the PR, or
- including `<!-- visual-diff:required -->` anywhere in the PR description.

On each push, the `Visual diff` GitHub Action captures screenshots from the PR
base commit and head commit, generates a diff report, uploads it as a workflow
artifact, and updates a sticky PR comment (`<!-- capgo-visual-diff -->`).

**Local workflow before opening or updating the PR:**

1. Capture the current UI baseline: `bun run visual:capture:before`
2. Apply your UI edits and rebuild or refresh the local app as needed.
3. Capture the updated UI: `bun run visual:capture:after`
4. Generate the report: `bun run visual:diff`
5. Paste `.context/visual-diff/report/summary.md` into the PR description under
   `## Visual changes`.
6. Add the `visual-change` label (or the HTML marker above) so CI refreshes the
   report on every push.

**Full local pipeline against `main`:**

```bash
bun run visual:run -- --base origin/main
```

**Route configuration:** edit `playwright/visual-diff.config.ts` when a PR
introduces a new screen that should be part of the visual diff set.

**Outputs:**

- `.context/visual-diff/before/` and `after/` — raw PNG captures
- `.context/visual-diff/report/index.html` — side-by-side before/after/diff view
- `.context/visual-diff/report/summary.md` — markdown table for the PR body

## Mobile Development

### Capacitor Configuration

- App ID: `ee.forgr.capacitor_go`
- Build command: `bun mobile` (builds and copies to platforms)
- iOS/Android projects in respective platform directories
- Uses Capacitor Updater plugin for OTA updates

## Database Replication

Our main database is hosted on Supabase. We use custom replica hosted in
Planetscale.

We have 5 read replicas for our main database to ensure high availability and
low latency for read operations. These replicas are synchronized with the
primary database using logical replication. We have one replica by continent:

- North America (Ohio)
- Europe (Frankfurt)
- Asia (Seoul)
- Australia (Sydney)
- South America (Sao Paulo)

Applications are configured to read from the nearest replica based on the user's
location. This repartition is done by Cloudflare snippets at
`cloudflare_workers/snippet/index.js`.

### Replica Data Contract (CRITICAL)

When backend code uses the plugin read-path (`/updates`, `/stats`, `/channel_self`), it must only query what exists in the read replicas.

- Logical replication replicates **table data**, not derived objects like **views** and **SQL functions**.
- Treat the read replica (what you see in PlanetScale) as the source of truth for what is queryable from plugin endpoints.
- Do **not** query credits ledger tables/views from the replica (e.g. `usage_credit_*` / `usage_credit_balances`). If plugin logic needs a “has credits” signal, **materialize it into a replicated column/table** (example: an org-level boolean flag that is refreshed by primary-side jobs).
- `/updates`, `/stats`, and `/channel_self` are extremely hot paths and can be called hundreds of times per second.
- Those endpoints must not call the primary Supabase/Postgres database in-request or through `backgroundTask()` side effects unless there is no other practical option.
- Background work is not an exception: do not enqueue primary-DB RPCs, writes, or lookups from these plugin endpoints just because the response is returned first.
- If an unavoidable primary write remains for one of these endpoints, keep it minimal, document the reason inline, and treat it as an exception that requires extra review.

## Pull Request Guidelines

### Required Sections

Every pull request MUST include the following sections:

1. **Summary** - Brief description of what changed
2. **Motivation** - Why this change is needed
3. **Business Impact** - How this affects Capgo's business, users, or revenue
4. **Test Plan** - Checklist for testing the changes

### AI-Generated Content Marking - MANDATORY

**CRITICAL: ALL sections in a PR created by AI agents MUST be marked with
"(AI generated)".**

Example:

```markdown
## Summary (AI generated)

- Fixed the build system RLS policies

## Motivation (AI generated)

The native build system needed consistent RLS patterns...

## Business Impact (AI generated)

This enables revenue growth by providing a working build system...

## Test Plan (AI generated)

- [ ] Verify authenticated users can access build requests
- [ ] Verify API key authentication works
```

**WARNING: Failure to mark AI-generated sections is a violation of transparency
requirements. If you do not mark sections as "(AI generated)", you are doing it
wrong and this is unacceptable behavior. You will be punished for not being
transparent about AI-generated content. ALWAYS mark every section with
"(AI generated)".**

### PR Template

```markdown
## Summary (AI generated)

- [Bullet points of changes]

## Motivation (AI generated)

[Why this change is needed]

## Business Impact (AI generated)

[How this affects Capgo - revenue, users, experience, etc.]

## Test Plan (AI generated)

- [ ] [Testing checklist]

Generated with AI
```

## API and Plugin Backward Compatibility

**CRITICAL: All changes to public APIs and plugin interfaces MUST be backward compatible.**

Customers take time to update their apps and plugins. Breaking changes cause production issues for users who haven't updated yet. Follow these rules:

### Backend API Changes

- **New fields**: Can be added freely - old clients will ignore them
- **Existing fields**: Never remove or change the type/meaning
- **New error codes**: Fine to add, but don't remove existing ones
- **Response format**: Must remain compatible with older plugin versions

### Plugin Version Detection

When behavior must differ between plugin versions, use version detection:

```typescript
const pluginVersion = body.plugin_version || '0.0.0'
let isNewVersion = false
try {
  const parsed = parse(pluginVersion)
  isNewVersion = !isDeprecatedPluginVersion(parsed, MIN_V5, MIN_V6, MIN_V7, MIN_V8)
}
catch (error) {
  // If version parsing fails, assume old version for safety
}

if (isNewVersion) {
  // New behavior for updated plugins
}
else {
  // Legacy behavior for old plugins
}
```

### Examples of Backward Compatible Changes

- **Adding a new optional response field**: Old plugins ignore it, new plugins use it
- **Changing error to success with new flag**: Return success with `unset: true` instead of error - old plugins see success, new plugins handle the flag
- **New endpoint**: Doesn't affect existing clients

### Examples of Breaking Changes (AVOID)

- Removing a response field that old plugins depend on
- Changing the meaning of an existing field
- Returning different HTTP status codes for the same scenario
- Removing support for old request formats

**When in doubt, support both old and new behavior based on plugin version detection.**

## Deployment

The deployment happens automatically after GitHub CI/CD on main branch.

You are not allowed to deploy on your own, unless if asked. Same for git you
never git push on main branch, add or commit unless asked.
You can do it in others branches

## Graphify

The project-scoped Graphify skill lives at `.agents/skills/graphify/SKILL.md`.
Use it for questions about architecture, file relationships, dead code, used
code, and where code is used.

Rules:
- When the user types `/graphify`, follow the project skill before doing
  anything else.
- `graphify-out/graph.json` is committed and refreshed during release version
  bumps. Prefer `graphify query "<question>"`, `graphify affected "<node>"`,
  `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` before broad
  source searches.
- Use `bun run graphify:generate` to refresh the committed code graph. The
  generator is deterministic AST/code extraction and does not require LLM API
  keys.
- For deterministic unused export checks, keep using `bun run lint:deadcode`
  alongside Graphify's graph queries.
- After code changes that should update the repository graph, run
  `bun run graphify:generate` and commit the resulting `graphify-out/` changes.

## Cursor Cloud specific instructions

These notes capture non-obvious caveats for running the stack in the Cursor
Cloud VM. Standard commands live in the sections above; only the gotchas are
repeated here.

- **Docker must be started manually.** systemd is not running in the VM, so the
  Docker daemon does not auto-start. Run `sudo service docker start` once per VM
  boot before any Supabase command. The `ubuntu` user is already in the
  `docker` group, so `docker`/`supabase` work without `sudo` after the daemon is
  up. The daemon uses the `fuse-overlayfs` storage driver (configured in
  `/etc/docker/daemon.json`) — do not switch it to `overlay2`.
- **Supabase ports are worktree-isolated, not the documented defaults.** Each
  git worktree gets its own ports (e.g. the API may be on `57671`, not `54321`).
  Always run `bun run supabase:status` to read the current `SUPABASE_URL`,
  keys, and DB URL. The worktree state lives under `.context/` (a local,
  untracked artifact — do not commit it).
- **Run the frontend with `bun run serve:worktree`, not `bun serve:local`.**
  `serve:worktree` auto-injects the current worktree's Supabase URL/anon key into
  the Vite dev server (still served on `http://localhost:5173`). Plain
  `bun serve:local` points at the default ports, which will not match the
  worktree's Supabase instance.
- **Backend edge functions:** `bun run supabase:functions:serve` (or `bun
  backend` to start Supabase + serve). They are served under the worktree API
  URL at `/functions/v1/<name>`; `/functions/v1/ok` returns `{"status":"ok"}`.
- **Tests need Supabase running and must be wrapped with the worktree env.** The
  `test:*` scripts already wrap with `bun run supabase:with-env --`; for ad-hoc
  single-file runs use e.g.
  `bun run supabase:with-env -- bunx vitest run tests/app.test.ts`.
- Local login uses the seeded accounts from the README: `test@capgo.app` /
  `testtest` (demo data) and `admin@capgo.app` / `adminadmin` (admin).
  Re-run `bun run supabase:db:reset` to refresh seed data.
- Cloudflare Workers and the Playwright/Stripe harnesses are optional; the
  product runs end-to-end on the Supabase stack + Vite frontend alone.
