# App PUT JWT Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `PUT /app/:appId` to authenticate signed-in users with Supabase JWTs without breaking API-key, subkey, published CLI, or self-hosted CLI callers.

**Architecture:** Reuse `middlewareAuth()` at the route boundary with a route-scoped option that makes an explicit `capgkey` take precedence over a simultaneous project bearer token. Inside the handler, select the RLS-enforcing Supabase client from the normalized `AuthInfo` using `supabaseWithAuth()` instead of requiring an API-key row.

**Tech Stack:** TypeScript, Hono, Supabase/PostgREST, Vitest, Bun

---

## Task 1: Add failing dual-auth integration coverage

**Files:**
- Modify: `tests/app.test.ts`

- [ ] **Step 1: Add a JWT update test**

Extend the existing `[POST]/[PUT] /app onboarding progress` suite with an authenticated JWT request that changes a settings field and sends an onboarding patch:

```ts
const jwtHeaders = await getAuthHeaders()
const jwtPut = await fetchTestRequest(`${BASE_URL}/app/${APPNAME}`, {
  method: 'PUT',
  headers: jwtHeaders,
  body: JSON.stringify({
    name: `JWT ${APPNAME}`,
    onboarding: { outcome: 'switched_to_manual' },
  }),
})
expect(jwtPut.status).toBe(200)
```

Assert that the returned row contains the new name and merged onboarding outcome.

- [ ] **Step 2: Add authorization and CLI-header compatibility tests**

Add one request using a non-member JWT and assert `401`. Add another request with a bearer project token plus the existing API key in `capgkey` and assert `200`; this models the self-hosted published-CLI header shape.

- [ ] **Step 3: Confirm the pre-change behavior**

The focused integration test requires local Supabase. Per the agreed lightweight workflow, delegate it to CI instead of starting Docker locally. The new JWT request should fail before the route switches away from `middlewareKey()`.

## Task 2: Implement dual authentication without changing authorization

**Files:**
- Modify: `supabase/functions/_backend/utils/hono_middleware.ts`
- Modify: `supabase/functions/_backend/public/app/index.ts`
- Modify: `supabase/functions/_backend/public/app/put.ts`

- [ ] **Step 1: Preserve explicit `capgkey` precedence**

Add an optional `preferApiKey` setting to `middlewareAuth()`. When enabled and `resolveAuthHeaders()` returns an explicit `capgkey`, call `foundAPIKey()` before considering `foundJWT()`. Preserve the existing behavior for every caller that does not enable the option, including UUID-in-`Authorization` conversion.

- [ ] **Step 2: Switch the route to dual authentication**

Change the app PUT route from `middlewareKey()` to `middlewareAuth({ preferApiKey: true })`. Stop extracting and passing an API-key-only argument from the router.

- [ ] **Step 3: Select the database client from `AuthInfo`**

In `public/app/put.ts`, obtain the normalized auth context and create the caller-scoped client:

```ts
const auth = c.get('auth')
if (!auth)
  throw quickError(401, 'not_authorized', 'Not authorized')
const authClient = supabaseWithAuth(c, auth)
```

Use `authClient` for the previous-app read and the general RLS-backed settings update. Keep the existing explicitly authorized direct-PostgreSQL onboarding paths unchanged.

- [ ] **Step 4: Run focused integration tests in CI**

CI runs the Supabase-backed tests, proving JWT and legacy key/subkey behavior without starting Docker locally.

## Task 3: Verify repository contracts and prepare the PR

**Files:**
- Verify: `supabase/functions/_backend/public/app/index.ts`
- Verify: `supabase/functions/_backend/public/app/put.ts`
- Verify: `supabase/functions/_backend/utils/hono_middleware.ts`
- Verify: `tests/app.test.ts`

- [ ] **Step 1: Run formatting and backend lint**

Run:

```bash
bun lint:backend
```

Expected: exit code 0.

- [ ] **Step 2: Run lightweight local checks and integration tests in CI**

Run the local unit suite and typecheck. Let CI run Supabase-backed integration and published-CLI contract tests.

- [ ] **Step 3: Review the final diff and commit**

Verify that no onboarding semantics or permissions changed, then commit with:

```bash
git commit -m "feat(api): allow JWT app updates"
```

- [ ] **Step 4: Push, open the PR, and invoke `pr-ready`**

Push `wolny/jwt-app-put`, open a GitHub pull request without a `[CODEX]` prefix, and follow the repository `pr-ready` skill until the PR is stable-green.
