# API-Key Creation Permission Batching Design

**Date:** 2026-08-16
**Status:** Approved design, pending written-spec review

## Problem

`POST /apikey` performs the same two organization-scoped authorization decisions in
two intentionally distinct phases:

1. before opening the transaction, so an unauthorized request cannot acquire RBAC
   organization locks;
2. inside the transaction after acquiring those locks, so a concurrent permission
   change cannot create a time-of-check/time-of-use authorization gap.

For every requested organization, each phase checks `org.manage_apikeys` and
`org.update_user_roles` through a separate awaited PostgreSQL statement. A request
covering ten organizations therefore makes 40 permission-query round trips before
performing the API-key and role-binding writes.

Production query statistics show that an ordinary
`rbac_check_permission_direct(...)` execution is fast (about 2.9 ms on average) and
primarily uses cached pages. The observed endpoint latency is therefore dominated by
serial application-to-database round trips rather than expensive permission
computation or a missing index.

## Goals

- Preserve both preflight and post-lock authorization phases.
- Preserve the independent meanings of `org.manage_apikeys` and
  `org.update_user_roles`.
- Reduce permission-query round trips from 40 to 2 for an authorized
  ten-organization request that reaches the transaction.
- Keep authorization errors, transaction atomicity, and lock ordering unchanged.
- Use one request-scoped PostgreSQL pool instead of creating a pool for every
  standalone permission check.
- Make the smallest practical backend-only change without a database migration.

## Non-goals

- Do not remove either authorization phase.
- Do not parallelize permission checks with `Promise.all` or increase pool size.
- Do not change `rbac_check_permission_direct`, RBAC roles, permissions, policies, or
  schema.
- Do not change `lockRbacOrgs` or its advisory-lock ordering.
- Do not batch role-binding creation, API-key writes, or global-permission writes in
  this change.
- Do not change Cloudflare Worker placement or Hyperdrive configuration.
- Do not optimize unrelated API-key endpoints.

## Considered Approaches

### 1. One set-based permission query per phase

Bind every unique organization ID as an individual text value and construct the
PostgreSQL text array in the query so each caller-provided string remains the
result-map key. Use PostgreSQL's built-in `unnest()` function to turn the array into
rows and evaluate both permission functions as columns for every valid UUID row.

This produces one database statement before the transaction and one after the locks
are acquired. PostgreSQL still evaluates both permissions independently for every
organization; the optimization removes network round trips rather than authorization
work.

This is the selected approach.

### 2. One query per permission per phase

Batch all `org.manage_apikeys` checks separately from all
`org.update_user_roles` checks. This preserves behavior but requires four round trips
instead of two and provides no compensating safety advantage.

### 3. Concurrent individual queries

Run existing per-organization checks through `Promise.all`. This retains 40 database
statements, adds connection pressure before the transaction, and cannot make queries
on the single transaction connection execute concurrently. This approach is rejected.

## Architecture

### Batched permission loader

Add a PostgreSQL-backed helper alongside the existing RBAC permission helpers. It
accepts:

- the Hono request context;
- the deduplicated organization IDs;
- the existing Drizzle executor, which may be either the normal client or transaction;
- the authenticated user ID and API-key string context expected by the existing direct
  RBAC function.

It returns one permission snapshot per requested organization:

```ts
interface ApiKeyOrgPermissionSnapshot {
  canManageApiKeys: boolean
  canUpdateUserRoles: boolean
}
```

The query has this conceptual shape:

```sql
SELECT
  requested_orgs.org_id,
  CASE WHEN pg_input_is_valid(requested_orgs.org_id, 'uuid') THEN
    public.rbac_check_permission_direct(
      'org.manage_apikeys', $1::uuid, requested_orgs.org_id::uuid, NULL, NULL, $2
    )
  ELSE false END AS can_manage_apikeys,
  CASE WHEN pg_input_is_valid(requested_orgs.org_id, 'uuid') THEN
    public.rbac_check_permission_direct(
      'org.update_user_roles', $3::uuid, requested_orgs.org_id::uuid, NULL, NULL, $4
    )
  ELSE false END AS can_update_user_roles
FROM unnest(ARRAY[$5::text, $6::text, ...]::text[])
  WITH ORDINALITY AS requested_orgs(org_id, ordinal)
ORDER BY ordinal;
```

`unnest()` is built into PostgreSQL and requires no extension, migration, temporary
table, or persistent database object. `WITH ORDINALITY` retains input order, although
the application will make authorization decisions by iterating the original
deduplicated organization list rather than trusting row order. Keeping `org_id` as
text also preserves uppercase or otherwise non-canonical valid UUID strings as exact
map keys. Binding the values separately avoids driver-specific JavaScript-array
serialization, including the single-element case. Each permission expression uses
`pg_input_is_valid` before casting only that row for evaluation, so a malformed
organization ID produces two `false` permissions without aborting or dropping later
rows.

The helper must retain current permission-check failure semantics:

- a transient PostgreSQL, Hyperdrive, timeout, or connection failure becomes the
  existing `503 upstream_unavailable` response;
- a non-transient query failure is treated as denied;
- a malformed organization ID yields both permissions as `false` for only that row;
- a missing result row or missing boolean is treated as denied;
- no permission-query error may default to allowed.

### Pure authorization decisions

Keep SQL execution separate from authorization error construction. The existing role
assignment guard will expose or delegate to a pure validator that accepts the loaded
`canUpdateUserRoles` results. This preserves its per-organization sensitive-role logic
without requiring another query.

The `org.manage_apikeys` assertion will similarly consume the loaded snapshot and emit
the existing `403 forbidden_binding` error containing the denied organization ID.

The existing asynchronous role-assignment helper remains available for current callers
such as `PUT /apikey`; this design changes only the `POST /apikey` path.

## Request Flow

After request parsing, binding sanitization, expiration validation, and organization
policy validation:

1. Deduplicate binding organization IDs using the existing order.
2. Create one request-scoped PostgreSQL pool and Drizzle client.
3. Execute the preflight batched permission query.
4. Preserve current preflight error precedence:
   1. validate `org.update_user_roles` against requested sensitive roles;
   2. require `org.manage_apikeys` for every organization.
5. Begin the existing transaction.
6. Call `lockRbacOrgs` unchanged.
7. Execute a fresh batched permission query through the transaction executor.
8. Preserve current transactional error precedence:
   1. require `org.manage_apikeys` for every organization;
   2. validate `org.update_user_roles` against requested sensitive roles.
9. Create the API key, role bindings, and global permissions exactly as today.
10. Close the request-scoped pool in the existing `finally` path.

The second snapshot must never reuse the preflight result. It is deliberately fetched
after the locks to protect against permission changes between the two phases.

## Execution Model

For an authorized request with ten unique organizations that reaches the transaction:

| Measurement | Current | Designed |
| --- | ---: | ---: |
| Authorization phases | 2 | 2 |
| Logical permission decisions | 40 | 40 |
| `rbac_check_permission_direct` evaluations | 40 | 40 |
| Permission SQL statements | 40 | 2 |
| Concurrent permission connections | 1 at a time | 1 at a time |

PostgreSQL is not expected to run the RBAC function evaluations in parallel. The
function is currently classified as parallel-unsafe, and parallel workers would not
benefit these small indexed lookups. The performance gain comes from removing 38
application/database round trips and repeated standalone pool creation.

## Error Handling and Security

- Unauthorized requests are rejected before acquiring RBAC organization locks.
- The same permissions are checked again after locks are acquired and before any write.
- The transaction continues to roll back the API key and all bindings together.
- Every requested organization must have `org.manage_apikeys`.
- A missing `org.update_user_roles` permission continues to reject only the existing
  sensitive role set for that organization.
- Authorization remains deny-by-default for missing or failed results, while malformed
  organization IDs are isolated as denied rows and cannot erase later valid results.
- Existing HTTP status codes, error codes, and user-facing messages remain unchanged.
- The implementation must not interpolate organization IDs or permission keys as raw
  SQL; all values remain bound parameters.

## Testing and Verification

### Unit coverage

- Verify that loading both permissions for multiple organization IDs calls the Drizzle
  executor exactly once.
- Verify that returned rows map to the correct organization and permission booleans.
- Verify that uppercase valid UUID input remains the exact result-map key.
- Verify that a malformed row returns two false permissions without dropping later
  valid rows.
- Verify that missing rows and false/null values deny access.
- Verify that transient infrastructure errors remain `503 upstream_unavailable` and
  non-transient permission-query errors deny access.
- Verify the pure role-assignment validator preserves sensitive-role behavior per
  organization.
- Verify an authorized `POST /apikey` request invokes the batched loader exactly twice:
  once before the transaction and once after `lockRbacOrgs` inside it. A denied
  preflight request must stop after the first call.

### Existing integration coverage

Run the focused API-key creation, scope, and atomic-binding tests. They must continue to
cover successful creation, nonexistent or unauthorized organizations, sensitive-role
rejection, permitted lower-privilege roles, and transaction rollback. API-key creation
coverage must also exercise an uppercase authorized organization UUID and a malformed
first organization followed by a valid sensitive binding, preserving the first
organization's management-denial precedence.

### Query-plan and latency verification

- Run `EXPLAIN (ANALYZE, BUFFERS)` for the batched query using ten organizations and
  both permissions against production-like RBAC data.
- Confirm bounded indexed lookups and no sequential scan over large RBAC tables.
- Record the plan summary and before/after endpoint timing in the pull-request notes.
- Confirm the implementation performs two permission SQL statements regardless of the
  number of organizations in the request.

## Acceptance Criteria

- Both authorization phases and their current ordering relative to locks remain.
- An authorized ten-organization request that reaches the transaction performs two
  permission SQL statements, not 40.
- Both permissions are still independently evaluated for all ten organizations in both
  phases.
- Original organization strings remain map keys, and malformed rows deny only
  themselves without aborting the batch.
- No additional connections, database objects, migrations, or permissions are added.
- Existing authorization and atomicity tests pass without weakened assertions.
- Backend lint and type checking pass.
