# Appflow -> Capgo migration in `capgo build init` - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Both, I'm migrating from Ionic Appflow" option to `capgo build init` that logs into
Appflow, lets the user pick an org + app, pulls that app's signing + distribution credentials, maps
them into Capgo build credentials, and then reuses the existing onboarding tail (validate -> build ->
AI/email support -> CI/CD).

**Architecture:** A new, isolated `appflow/` flow under `cli/src/build/onboarding/` implementing the
existing `PlatformFlow` contract. It is its OWN flow (not a merge into the native flows): it reuses
the same neutral `StepView` model, the same per-app/per-platform Capgo credential store, and the same
tail COMPONENTS (build/AI/support/CI-CD), but drives them itself. Credential acquisition (auth, org,
app, fetch, map) is new; gap-fill generation (step 6 only), validation, build, and CI/CD reuse
existing code by name.

**Tech Stack:** TypeScript, Node 18+ (global `fetch`), Ink TUI, `node:crypto`/`node:http` for PKCE,
the existing onboarding engine (`mcp/engine.ts`), `vitest`/`bun` `.mjs` tests in the CLI, and the
private `Cap-go/cli-mcp-tests` e2e harness.

## Global Constraints

(Copied from the spec; every task implicitly includes these.)

- All Appflow calls use dashboard headers: `Authorization: Bearer ion_<token>`, `Content-Type:
  application/json`, `Origin: https://dashboard.ionicframework.com`, and User-Agent
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0`.
- Endpoints: authorize `https://ionicframework.com/oauth/authorize`; token `https://api.ionicjs.com/oauth/token`
  (form-urlencoded); audience `https://api.ionicjs.com`; `client_id=cli`; scope
  `openid profile email offline_access`; loopback `http://localhost:8123`; GraphQL + REST base
  `https://api.ionicjs.com`.
- NO dependency on `@ionic/cli`. Port the PKCE pathway.
- Platform value is `appflow`; picker LABEL is "Both, I'm migrating from Ionic Appflow".
- Secrets (tokens, app-specific passwords, cert/keystore bytes, service-account JSON) are NEVER
  written to logs. The Appflow API client records a redacted request/response trace into the
  onboarding internal log so the existing support bundle carries it.
- Validation (step 7) is ADVISORY: results are always SURFACED (confirmation on pass, non-fatal
  warning on fail, "skipped" surfaced) and NEVER block; the user can always continue to build.
- Migration NEVER generates signing creds (migrate-or-skip). Gap-fill generation exists ONLY for
  step-6 distribution creds (iOS p8, Android service account), reusing existing flows.
- Auto-select singletons: org, app, and signing cert are auto-selected with NO prompt when exactly
  one exists; prompt only for 2+.
- Reuse existing onboarding code by name (see spec section 6); do not reimplement it.
- Tests: NEW e2e journeys in `Cap-go/cli-mcp-tests` (hard requirement) + CLI unit/contract tests.
- Spec: docs/superpowers/specs/2026-06-22-appflow-migration-build-init-design.md (read it first).

## File structure

New:
- `cli/src/build/onboarding/appflow/auth.ts` - PKCE login + token cache/refresh.
- `cli/src/build/onboarding/appflow/api.ts` - GraphQL+REST client (redacted trace), operations,
  credential download + Appflow->Capgo mapping helpers.
- `cli/src/build/onboarding/appflow/types.ts` - `AppflowStep` union + `AppflowProgress`.
- `cli/src/build/onboarding/appflow/flow.ts` - `appflowFlow: PlatformFlow<AppflowStep, AppflowProgress, AppflowInput>`.
- `cli/src/build/onboarding/ios/validate-app-password.ts` - `authenticateForSession` helper.
- Tests: `cli/test/test-appflow-auth.mjs`, `test-appflow-api-map.mjs`, `test-appflow-validate.mjs`,
  `test-appflow-flow.mjs`.

Modified:
- `cli/src/build/onboarding/types.ts` - add `'appflow'` to `Platform`.
- `cli/src/build/onboarding/ui/platform-picker.tsx` - add the third option (both layouts + key action).
- `cli/src/build/onboarding/mcp/engine.ts` - `decideAppflow()` + route in `drive()`/`decidePlatform()`;
  suppress `appflow` option after a "no signing material -> restart".
- the flow registry that maps a `Platform` to its `PlatformFlow` - register `appflowFlow`.
- `Cap-go/cli-mcp-tests` - new e2e journey fixtures + tests (separate repo PR).

---

### Task 1: Appflow PKCE auth module (`appflow/auth.ts`)

**Files:**
- Create: `cli/src/build/onboarding/appflow/auth.ts`
- Test: `cli/test/test-appflow-auth.mjs`

**Interfaces:**
- Produces: `loginWithBrowser(opts?: { openBrowser?: (url: string) => void }): Promise<AppflowToken>`;
  `refresh(token: AppflowToken): Promise<AppflowToken>`;
  `isExpired(token: AppflowToken, marginMs?: number): boolean`;
  `buildAuthorizeUrl(verifier: string, state: string, nonce: string): string`;
  `pkce(): { verifier: string, challenge: string }`.
  Type `AppflowToken = { access_token: string, refresh_token?: string, expires_in: number, id_token?: string, capturedAtMs: number }`.

- [ ] **Step 1: Write failing test for PKCE + authorize URL (pure, no network)**

```js
// cli/test/test-appflow-auth.mjs
import assert from 'node:assert'
const { pkce, buildAuthorizeUrl, isExpired } = await import('../src/build/onboarding/appflow/auth.ts')

const { verifier, challenge } = pkce()
assert.ok(verifier.length >= 43 && !/[+/=]/.test(verifier), 'verifier is base64url, no padding')
assert.ok(challenge.length >= 43 && !/[+/=]/.test(challenge), 'challenge is base64url S256')
assert.notStrictEqual(verifier, challenge, 'challenge != verifier')

const url = new URL(buildAuthorizeUrl(verifier, 'st8', 'nonce1'))
assert.strictEqual(url.origin + url.pathname, 'https://ionicframework.com/oauth/authorize')
assert.strictEqual(url.searchParams.get('client_id'), 'cli')
assert.strictEqual(url.searchParams.get('audience'), 'https://api.ionicjs.com')
assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://localhost:8123')
assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256')
assert.strictEqual(url.searchParams.get('scope'), 'openid profile email offline_access')

assert.strictEqual(isExpired({ expires_in: 43200, capturedAtMs: Date.now() }), false)
assert.strictEqual(isExpired({ expires_in: 43200, capturedAtMs: Date.now() - 43200_000 }), true)
console.log('auth pkce/url/expiry OK')
```

- [ ] **Step 2: Run it, verify it fails** - `cd cli && bun test/test-appflow-auth.mjs` -> FAIL (module missing).

- [ ] **Step 3: Implement `appflow/auth.ts`**

```ts
// cli/src/build/onboarding/appflow/auth.ts
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'

const AUTHORIZE_URL = 'https://ionicframework.com/oauth/authorize'
const TOKEN_URL = 'https://api.ionicjs.com/oauth/token'
const AUDIENCE = 'https://api.ionicjs.com'
const CLIENT_ID = 'cli'
const REDIRECT_URI = 'http://localhost:8123'
const REDIRECT_PORT = 8123
const SCOPE = 'openid profile email offline_access'

export interface AppflowToken { access_token: string, refresh_token?: string, expires_in: number, id_token?: string, capturedAtMs: number }

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function pkce() { const verifier = b64url(randomBytes(32)); return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) } }
const genNonce = () => b64url(randomBytes(32))

export function buildAuthorizeUrl(challenge: string, state: string, nonce: string): string {
  const u = new URL(AUTHORIZE_URL)
  for (const [k, v] of Object.entries({
    audience: AUDIENCE, scope: SCOPE, response_type: 'code', client_id: CLIENT_ID,
    code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: REDIRECT_URI, nonce, state,
  })) u.searchParams.set(k, v)
  return u.toString()
}

export function isExpired(t: Pick<AppflowToken, 'expires_in' | 'capturedAtMs'>, marginMs = 60_000): boolean {
  return Date.now() >= t.capturedAtMs + t.expires_in * 1000 - marginMs
}

function defaultOpen(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref() } catch {}
}

function waitForCode(): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '', REDIRECT_URI)
      const code = u.searchParams.get('code'); const error = u.searchParams.get('error')
      if (!code && !error) { res.writeHead(204); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body style="font-family:system-ui;padding:3rem"><h2>You can close this tab.</h2></body></html>')
      req.socket.destroy(); server.close()
      error ? reject(new Error(`authorize error=${error}`)) : resolve({ code: code! })
    })
    server.on('error', reject)
    server.listen(REDIRECT_PORT, 'localhost')
    setTimeout(() => { server.close(); reject(new Error('timed out waiting for the browser redirect')) }, 5 * 60 * 1000)
  })
}

async function exchange(body: Record<string, string>): Promise<AppflowToken> {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body) })
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`)
  const j = await res.json() as Omit<AppflowToken, 'capturedAtMs'>
  return { ...j, capturedAtMs: Date.now() }
}

export async function loginWithBrowser(opts: { openBrowser?: (url: string) => void } = {}): Promise<AppflowToken> {
  const { verifier, challenge } = pkce()
  const url = buildAuthorizeUrl(challenge, b64url(randomBytes(16)), genNonce())
  const codeP = waitForCode()
  ;(opts.openBrowser ?? defaultOpen)(url)
  const { code } = await codeP
  return exchange({ grant_type: 'authorization_code', client_id: CLIENT_ID, code_verifier: verifier, code, redirect_uri: REDIRECT_URI })
}

export async function refresh(token: AppflowToken): Promise<AppflowToken> {
  if (!token.refresh_token) throw new Error('no refresh_token')
  const t = await exchange({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: token.refresh_token })
  return { refresh_token: token.refresh_token, ...t }
}
```

- [ ] **Step 4: Run test, verify PASS** - `cd cli && bun test/test-appflow-auth.mjs` -> "auth pkce/url/expiry OK".

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd cli && bun run typecheck && bun run lint
git add cli/src/build/onboarding/appflow/auth.ts cli/test/test-appflow-auth.mjs
git commit -m "feat(onboarding): Appflow PKCE auth module"
```

---

### Task 2: Appflow API client + credential mapping (`appflow/api.ts`)

**Files:**
- Create: `cli/src/build/onboarding/appflow/api.ts`
- Test: `cli/test/test-appflow-api-map.mjs`

**Interfaces:**
- Consumes: `AppflowToken` (Task 1); an internal-log sink `(line: string) => void` (the existing
  onboarding internal logger; injected so it is testable and so secrets never leak).
- Produces: `createAppflowApi(token: string, log?: (s: string) => void)` returning
  `{ listOrgs(): Promise<Org[]>, listApps(slug: string): Promise<App[]>, listCertificates(appId): Promise<Cert[]>,
     listDistribution(appId): Promise<DistCred[]>, fetchIosSigning(appId, tag): Promise<CapgoIosSigning>,
     fetchAndroidSigning(appId, tag): Promise<CapgoAndroidSigning>, fetchIosDistribution(appId, id): Promise<CapgoIosDist>,
     fetchAndroidDistribution(appId, id): Promise<CapgoAndroidDist> }`.
  Pure helpers (export for tests): `stripDataUri(s)`, `bundleIdFromAppIdentifier(ai)`,
  `mapIosSigning(raw)`, `mapAndroidSigning(raw)`, `mapIosDistribution(raw)`, `mapAndroidDistribution(raw)`,
  `redactTrace(method, url, status, bodyShapeKeys)`.

- [ ] **Step 1: Write failing test for the PURE mapping + redaction helpers (no network)**

```js
// cli/test/test-appflow-api-map.mjs
import assert from 'node:assert'
const m = await import('../src/build/onboarding/appflow/api.ts')

assert.strictEqual(m.stripDataUri('data:application/x-pkcs12;base64,QUJD'), 'QUJD')
assert.strictEqual(m.stripDataUri('QUJD'), 'QUJD')
assert.strictEqual(m.bundleIdFromAppIdentifier('4TDEWHFV5T.com.aramco.cycomm'), 'com.aramco.cycomm')

const ios = m.mapIosSigning({ cert_file: 'data:application/x-pkcs12;base64,Q0VSVA==', cert_password: 'NovaCerts',
  provisioning_profiles: [{ application_identifier: '4TDEWHFV5T.com.x.y', name: 'Prof', provisioning_profile_file: 'data:application/x-apple-aspen-mobileprovision;base64,UFJPRg==' }] })
assert.strictEqual(ios.BUILD_CERTIFICATE_BASE64, 'Q0VSVA==')
assert.strictEqual(ios.P12_PASSWORD, 'NovaCerts')
assert.deepStrictEqual(JSON.parse(ios.CAPGO_IOS_PROVISIONING_MAP), { 'com.x.y': { profile: 'UFJPRg==', name: 'Prof' } })

const id = m.mapIosDistribution({ user_name: 'a@b.com', app_specific_password: 'w-x-y-z', apple_app_id: 1234, team_id: 'TEAM' })
assert.deepStrictEqual(id, { FASTLANE_USER: 'a@b.com', FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: 'w-x-y-z', APPLE_APP_ID: '1234', APP_STORE_CONNECT_TEAM_ID: 'TEAM' })

const and = m.mapAndroidSigning({ keystore_file: 'data:application/octet-stream;base64,S1M=', keystore_password: 'p1', key_password: 'p2', key_alias: 'al' })
assert.deepStrictEqual(and, { ANDROID_KEYSTORE_FILE: 'S1M=', KEYSTORE_STORE_PASSWORD: 'p1', KEYSTORE_KEY_PASSWORD: 'p2', KEYSTORE_KEY_ALIAS: 'al' })

const ad = m.mapAndroidDistribution({ json_key_file: 'data:application/octet-stream;base64,U0E=' })
assert.deepStrictEqual(ad, { PLAY_CONFIG_JSON: 'U0E=' })

// redaction: a trace line must never contain a secret value
const line = m.redactTrace('GET', 'https://api.ionicjs.com/apps/X/profiles/T/credentials/ios', 200, ['cert_file', 'cert_password'])
assert.ok(!line.includes('NovaCerts') && !line.includes('Q0VSVA=='), 'trace carries no secret values')
assert.ok(line.includes('200') && line.includes('credentials/ios'), 'trace carries method/url/status/shape')
console.log('api mapping + redaction OK')
```

- [ ] **Step 2: Run it, verify it fails** - `cd cli && bun test/test-appflow-api-map.mjs` -> FAIL.

- [ ] **Step 3: Implement `appflow/api.ts`** (mapping helpers shown in full; the network methods use
  these + the dashboard headers and push a redacted trace line per call).

```ts
// cli/src/build/onboarding/appflow/api.ts
const API = 'https://api.ionicjs.com'
const DASH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0'
const ORIGIN = 'https://dashboard.ionicframework.com'

export const stripDataUri = (s: string): string => (typeof s === 'string' && s.includes('base64,')) ? s.split('base64,')[1] : s
export const bundleIdFromAppIdentifier = (ai: string): string => String(ai || '').split('.').slice(1).join('.') || String(ai || '')

export function mapIosSigning(raw: any): Record<string, string> {
  const provMap: Record<string, { profile: string, name: string }> = {}
  for (const p of raw.provisioning_profiles || [])
    provMap[bundleIdFromAppIdentifier(p.application_identifier)] = { profile: stripDataUri(p.provisioning_profile_file), name: p.name }
  return { BUILD_CERTIFICATE_BASE64: stripDataUri(raw.cert_file), P12_PASSWORD: raw.cert_password ?? '', CAPGO_IOS_PROVISIONING_MAP: JSON.stringify(provMap) }
}
export function mapIosDistribution(raw: any): Record<string, string> {
  return { FASTLANE_USER: raw.user_name, FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: raw.app_specific_password, APPLE_APP_ID: String(raw.apple_app_id), APP_STORE_CONNECT_TEAM_ID: raw.team_id }
}
export function mapAndroidSigning(raw: any): Record<string, string> {
  return { ANDROID_KEYSTORE_FILE: stripDataUri(raw.keystore_file), KEYSTORE_STORE_PASSWORD: raw.keystore_password, KEYSTORE_KEY_PASSWORD: raw.key_password, KEYSTORE_KEY_ALIAS: raw.key_alias }
}
export function mapAndroidDistribution(raw: any): Record<string, string> {
  return { PLAY_CONFIG_JSON: stripDataUri(raw.json_key_file) }
}
export const redactTrace = (method: string, url: string, status: number | string, shapeKeys: string[]): string =>
  `appflow ${method} ${url} -> ${status} {${shapeKeys.join(',')}}`

const Q_BOOTSTRAP = `query BootstrapApp { viewer { organizations { edges { node { id name plan memberTotal slug apps { totalCount } } } } } }`
const Q_ORG_APPS = `query OrganizationApps($slug: String!, $first: Int) { organization(slug: $slug) { apps(first: $first) { edges { node { id name slug nativeType } } totalCount } } }`
const Q_CERTS = `query GetDataForPackageCerts($appId: String!) { app(id: $appId) { id name nativeType certificates { edges { node { id name tag type credentials { ios { filename fingerprint notValidAfter subjectCommonName provisioningProfiles { id applicationIdentifier filename } } android { filename fingerprint keyAlias notValidAfter subjectCommonName } } } } } } }`

export function createAppflowApi(token: string, log: (s: string) => void = () => {}) {
  const headers = { 'User-Agent': DASH_UA, Accept: '*/*', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: ORIGIN }
  async function rest(path: string): Promise<any> {
    const res = await fetch(`${API}${path}`, { headers })
    const j = await res.json().catch(() => null)
    log(redactTrace('GET', path, res.status, j?.data ? Object.keys(j.data) : []))
    return j?.data
  }
  async function gql(operationName: string, query: string, variables?: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${API}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables, operationName }) })
    const j = await res.json().catch(() => null)
    log(redactTrace('POST', `/graphql ${operationName}`, res.status, j?.data ? Object.keys(j.data) : []))
    return j?.data
  }
  return {
    async listOrgs() { const d = await gql('BootstrapApp', Q_BOOTSTRAP); return (d?.viewer?.organizations?.edges || []).map((e: any) => e.node) },
    async listApps(slug: string) { const d = await gql('OrganizationApps', Q_ORG_APPS, { slug, first: 100 }); return (d?.organization?.apps?.edges || []).map((e: any) => e.node) },
    async listCertificates(appId: string) { const d = await gql('GetDataForPackageCerts', Q_CERTS, { appId }); return (d?.app?.certificates?.edges || []).map((e: any) => e.node) },
    async listDistribution(appId: string) { return (await rest(`/apps/${appId}/distribution-credentials`)) || [] },
    async fetchIosSigning(appId: string, tag: string) { return mapIosSigning(await rest(`/apps/${appId}/profiles/${tag}/credentials/ios`)) },
    async fetchAndroidSigning(appId: string, tag: string) { return mapAndroidSigning(await rest(`/apps/${appId}/profiles/${tag}/credentials/android`)) },
    async fetchIosDistribution(appId: string, id: number | string) { return mapIosDistribution(await rest(`/apps/${appId}/distribution-credentials/${id}?fields=app_specific_password`)) },
    async fetchAndroidDistribution(appId: string, id: number | string) { return mapAndroidDistribution(await rest(`/apps/${appId}/distribution-credentials/${id}?fields=json_key_file`)) },
  }
}
```

- [ ] **Step 4: Run test, verify PASS** - `cd cli && bun test/test-appflow-api-map.mjs` -> "api mapping + redaction OK".

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd cli && bun run typecheck && bun run lint
git add cli/src/build/onboarding/appflow/api.ts cli/test/test-appflow-api-map.mjs
git commit -m "feat(onboarding): Appflow API client + Appflow->Capgo credential mapping"
```

---

### Task 3: iOS app-specific-password validator (`ios/validate-app-password.ts`)

**Files:**
- Create: `cli/src/build/onboarding/ios/validate-app-password.ts`
- Test: `cli/test/test-appflow-validate.mjs`

**Interfaces:**
- Produces: `validateAppleAppPassword(username: string, appPassword: string, fetchImpl?: typeof fetch):
  Promise<{ valid: boolean, code?: unknown, message?: string }>`. NEVER throws on auth failure;
  returns `{ valid: false, ... }`. On network error returns `{ valid: false, message }` (so the
  caller surfaces a warning, never blocks).

- [ ] **Step 1: Write failing test (inject a fake fetch; no live Apple call)**

```js
// cli/test/test-appflow-validate.mjs
import assert from 'node:assert'
const { validateAppleAppPassword } = await import('../src/build/onboarding/ios/validate-app-password.ts')

const ok = await validateAppleAppPassword('a@b.com', 'w-x-y-z', async () => ({ ok: true, json: async () => ({ result: { Success: true } }) }))
assert.strictEqual(ok.valid, true)
const bad = await validateAppleAppPassword('a@b.com', 'bad', async () => ({ ok: true, json: async () => ({ result: { Success: false, ErrorMessage: 'nope', ErrorCode: -20101 } }) }))
assert.strictEqual(bad.valid, false); assert.strictEqual(bad.message, 'nope')
const net = await validateAppleAppPassword('a@b.com', 'x', async () => { throw new Error('offline') })
assert.strictEqual(net.valid, false) // never throws
console.log('validate app-specific password OK')
```

- [ ] **Step 2: Run it, verify it fails** - `cd cli && bun test/test-appflow-validate.mjs` -> FAIL.

- [ ] **Step 3: Implement**

```ts
// cli/src/build/onboarding/ios/validate-app-password.ts
const ENDPOINT = 'https://contentdelivery.itunes.apple.com/WebObjects/MZLabelService.woa/json/MZITunesSoftwareService'

export async function validateAppleAppPassword(username: string, appPassword: string, fetchImpl: typeof fetch = fetch): Promise<{ valid: boolean, code?: unknown, message?: string }> {
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'iTMSTransporter/2.0.0' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'authenticateForSession', id: String(Date.now()), params: { Username: username, Password: appPassword } }),
    })
    const j: any = await res.json().catch(() => null)
    return { valid: j?.result?.Success === true, code: j?.result?.ErrorCode ?? j?.error?.code, message: j?.result?.ErrorMessage ?? j?.error?.message }
  } catch (e) {
    return { valid: false, message: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 4: Run test, verify PASS** - "validate app-specific password OK".

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd cli && bun run typecheck && bun run lint
git add cli/src/build/onboarding/ios/validate-app-password.ts cli/test/test-appflow-validate.mjs
git commit -m "feat(onboarding): iOS app-specific-password validator (authenticateForSession)"
```

---

### Task 4: Appflow step types + progress (`appflow/types.ts`)

**Files:**
- Create: `cli/src/build/onboarding/appflow/types.ts`

**Interfaces:**
- Produces: `type AppflowStep` (string union, below); `interface AppflowProgress`; `type AppflowInput`.

- [ ] **Step 1: Implement the types** (no test; consumed by Task 5's tests).

```ts
// cli/src/build/onboarding/appflow/types.ts
import type { AppflowToken } from './auth'

export type AppflowStep =
  | 'explain'            // step 1: secure-auth explanation + support note
  | 'authenticating'    // step 2: PKCE login (auto)
  | 'select-org'        // step 3 (auto-select if one)
  | 'select-app'        // step 4 (auto-select if one)
  | 'fetch-signing'     // step 5: list + download signing (auto)
  | 'select-ios-cert'   // step 5 prompt (2+ iOS certs)
  | 'select-android-cert' // step 5 prompt (2+ android certs)
  | 'no-signing-submenu'  // step 5 recovery submenu (per-platform or whole-migration)
  | 'fetch-distribution'  // step 6: list + download distribution (auto)
  | 'ios-dist-gapfill'    // step 6: no iOS dist -> offer p8 generate/provide
  | 'android-dist-gapfill'// step 6: no Android dist -> offer SA generate/provide
  | 'validate'            // step 7 (advisory, surfaced, non-blocking)
  | 'p8-upgrade-prompt'   // step 8 (iOS only)
  | 'handoff-build'       // converge: hand to the build/tail steps
  | 'done'
  | 'error'

export type NoSigningScope = 'ios' | 'android' | 'all'
export type MigrationScope = 'both' | 'ios' | 'android'
export interface AppflowProgress {
  scope: MigrationScope               // intent: which platform(s) the user chose to migrate
  token?: AppflowToken
  orgSlug?: string
  appId?: string
  appSlug?: string
  ios?: Record<string, string>     // mapped Capgo iOS creds collected so far
  android?: Record<string, string> // mapped Capgo Android creds collected so far
  migratable: { ios: boolean, android: boolean }
  noSigningScope?: NoSigningScope
  completedSteps: AppflowStep[]
}
export type AppflowInput = { value?: string, field?: string, text?: string }
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd cli && bun run typecheck
git add cli/src/build/onboarding/appflow/types.ts
git commit -m "feat(onboarding): Appflow step/progress types"
```

---

### Task 5: Appflow flow (`appflow/flow.ts`) - steps 1-6 + submenu, auto-select rule

**Files:**
- Create: `cli/src/build/onboarding/appflow/flow.ts`
- Test: `cli/test/test-appflow-flow.mjs`
- Read first (to mirror exact patterns): `ios/flow.ts` (`iosViewForStep`/`applyIosInput`/`runIosEffect`),
  `flow/contract.ts` (StepView), `progress.ts` (`getResumeStep`).

**Interfaces:**
- Consumes: `createAppflowApi` (Task 2), `loginWithBrowser`/`refresh`/`isExpired` (Task 1),
  `AppflowStep`/`AppflowProgress`/`AppflowInput` (Task 4).
- Produces: `appflowFlow: PlatformFlow<AppflowStep, AppflowProgress, AppflowInput>` and pure helpers
  `decideAfterFetchSigning(progress): AppflowStep`, `autoSelect<T>(items: T[]): T | 'prompt' | null`
  (returns the single item, `'prompt'` for 2+, `null` for 0).

- [ ] **Step 1: Write failing test for `autoSelect` + the no-signing routing (pure)**

```js
// cli/test/test-appflow-flow.mjs
import assert from 'node:assert'
const f = await import('../src/build/onboarding/appflow/flow.ts')

assert.strictEqual(f.autoSelect([]), null)
assert.deepStrictEqual(f.autoSelect(['only']), 'only')   // exactly one -> auto, no prompt
assert.strictEqual(f.autoSelect(['a', 'b']), 'prompt')   // 2+ -> prompt

// after fetch-signing: nothing migratable WITHIN SCOPE -> the submenu (scope defaults to 'both')
assert.strictEqual(f.decideAfterFetchSigning({ scope:'both', migratable: { ios: false, android: false } }), 'no-signing-submenu')
// at least one migratable in scope -> proceed to distribution
assert.strictEqual(f.decideAfterFetchSigning({ scope:'both', migratable: { ios: true, android: false } }), 'fetch-distribution')
// scope='android' but only iOS is migratable -> nothing in scope -> submenu
assert.strictEqual(f.decideAfterFetchSigning({ scope:'android', migratable: { ios: true, android: false } }), 'no-signing-submenu')

// viewForStep('explain') mentions support + that auth matches Ionic CLI
const v = f.appflowFlow.viewForStep('explain', { migratable: { ios: false, android: false }, completedSteps: [] })
assert.ok(/support@capgo\.app/.test(v.prompt))
assert.ok(/Ionic CLI|same/i.test(v.prompt))

// no-signing submenu has the four options
const sub = f.appflowFlow.viewForStep('no-signing-submenu', { migratable: { ios: false, android: false }, noSigningScope: 'all', completedSteps: [] })
const vals = (sub.options || []).map(o => o.value)
assert.deepStrictEqual(vals.sort(), ['abandon', 'email-support', 'go-back', 'skip'].sort())
console.log('appflow flow autoselect/routing/views OK')
```

- [ ] **Step 2: Run it, verify it fails** - `cd cli && bun test/test-appflow-flow.mjs` -> FAIL.

- [ ] **Step 3: Implement `appflow/flow.ts`.** Mirror `ios/flow.ts`'s structure: `viewForStep` returns
  a neutral `StepView` (kind/prompt/options/collect/context); `applyInput` is a pure reducer that
  records the choice into `AppflowProgress`; `runEffect` performs async work (login, list/fetch via
  `createAppflowApi`, mapping into `progress.ios`/`progress.android`, setting `migratable`). Implement:
  - `autoSelect` and `decideAfterFetchSigning` exactly as the tests expect.
  - `viewForStep('explain')` -> `{ kind: 'human_gate', prompt: "<secure-auth explanation; same secure
    flow as the Ionic CLI; nothing but your session token is read; if you hit ANY problem email
    support@capgo.app>" }`.
  - `viewForStep('select-org'|'select-app'|'select-ios-cert'|'select-android-cert')` -> `{ kind:
    'choice', prompt, options }` built from `ctx` lists; the EFFECT/driver auto-selects when exactly
    one (so these views are only reached for 2+).
  - `viewForStep('no-signing-submenu')` -> `{ kind: 'choice', prompt: "<platform> cannot be migrated -
    no signing configuration exists in Appflow", options: [{value:'email-support',label:"I believe
    credentials exist - email support"},{value:'skip',label:"I understand, do not migrate
    <platform>"},{value:'abandon',label:"Abandon Appflow migration and start <ios|android> onboarding
    instead"},{value:'go-back',label:"Go back"}] }`. Use `progress.noSigningScope` to fill <platform>.
  - `runEffect('authenticating')` -> reuse a saved token if `!isExpired`, else `loginWithBrowser()`;
    refresh when expired; store on `progress.token`.
  - `runEffect('fetch-signing')` -> `listCertificates(appId)`; consider ONLY platforms in
    `progress.scope` (scope `ios`/`android` ignores the other platform entirely); split by
    `credentials.ios`/`.android`; set `migratable.{ios,android}` (a platform out of scope is treated
    as not-migratable for routing); for each in-scope platform, if `autoSelect(certs)` is a single
    cert, `fetchIosSigning`/`fetchAndroidSigning` and merge into `progress.ios`/`.android`; if `'prompt'`,
    route to the select-cert step. Then route via `decideAfterFetchSigning` (scope-aware).
  - `runEffect('fetch-distribution')` -> `listDistribution(appId)`; for each in-scope migratable
    platform pull the matching dist cred (auto-select single) via
    `fetchIosDistribution`/`fetchAndroidDistribution` and merge; if absent, route to the matching
    `*-dist-gapfill` step.
  - Wire the internal-log sink into `createAppflowApi(token, logFn)` using the existing onboarding
    internal logger (the same one the support bundle reads).
  Keep secrets out of all `StepView.prompt`/`context`.

  (Code body mirrors `ios/flow.ts`; reproduce its `switch (step)` shape. The autoselect + routing
  helpers and the four submenu option values above are the load-bearing new logic and are fully
  specified by the test.)

- [ ] **Step 4: Run test, verify PASS** - "appflow flow autoselect/routing/views OK".

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd cli && bun run typecheck && bun run lint
git add cli/src/build/onboarding/appflow/flow.ts cli/test/test-appflow-flow.mjs
git commit -m "feat(onboarding): Appflow flow (auth/org/app/signing/distribution + no-signing submenu)"
```

---

### Task 6: Platform picker + `Platform` type - add the third option

**Files:**
- Modify: `cli/src/build/onboarding/types.ts` (`Platform`)
- Modify: `cli/src/build/onboarding/ui/platform-picker.tsx:80-110` (list + cards layouts; `platformKeyAction`)

**Interfaces:**
- Consumes: nothing new. Produces: `Platform` now includes `'appflow'`; picker emits `'appflow'`.

- [ ] **Step 1: Extend the type** - in `types.ts` change `export type Platform = 'ios' | 'android'`
  to `export type Platform = 'ios' | 'android' | 'appflow'`.

- [ ] **Step 2: Add the list-layout option** - in `platform-picker.tsx` list `Select`, after the
  Android option add: `{ label: '🔄  Both - migrating from Ionic Appflow', value: 'appflow' }`.

- [ ] **Step 3: Add the cards-layout option + key handling** - add a third `PlatformCard`
  (`emoji="🔄" name="Appflow" hint="Migrate from Ionic Appflow"`), include `'appflow'` in the
  ordered list `platformKeyAction` cycles through, and bind a key (e.g. `'3'`) to select it. Read
  `platformKeyAction` (lines 25-36) and extend its platform sequence to `['ios','android','appflow']`.

- [ ] **Step 4: Typecheck + manual render check** - `cd cli && bun run typecheck`; then run
  `bun run build && node dist/index.js build init` (or the existing dev entry) and confirm the picker
  shows three options in both layouts. (No unit test: this is presentational; covered by e2e in Task 12.)

- [ ] **Step 5: Commit**

```bash
git add cli/src/build/onboarding/types.ts cli/src/build/onboarding/ui/platform-picker.tsx
git commit -m "feat(onboarding): add 'Both, migrating from Appflow' to the platform picker"
```

---

### Task 7: Engine routing - `decideAppflow()` + restart-hides-appflow

**Files:**
- Modify: `cli/src/build/onboarding/mcp/engine.ts` (`drive()` ~L3706, `decidePlatform()` ~L216)
- Read first: `decideIos()` (~L921) and `decideAndroid()` (~L1902) for the exact return shape.

**Interfaces:**
- Consumes: `appflowFlow` (Task 5). Produces: a `decideAppflow(facts, deps, opts)` mirroring
  `decideIos`/`decideAndroid`, and a `drive()` branch `if (platform === 'appflow') return decideAppflow(...)`.

- [ ] **Step 1: Add `decideAppflow(facts, deps, opts, scope)`** mirroring `decideIos()`'s
  signature/return; it advances the `appflowFlow` step graph (resume -> view -> apply -> effect) the
  same way `decideIos` drives `iosFlow`, seeding `AppflowProgress.scope` from `scope`.

- [ ] **Step 2: Add the "migrating from Appflow?" gate + route in `drive()`/`decidePlatform()`:**
  - `platform === 'appflow'` (the "Both" picker option) -> `decideAppflow(..., scope='both')`.
  - `platform === 'ios'` -> first present a yes/no gate "Are you migrating from Ionic Appflow?"
    (a new `choice`/`human_gate` step at the very start of the iOS branch). YES ->
    `decideAppflow(..., scope='ios')`; NO -> the existing native iOS branch (`decideIos`).
  - `platform === 'android'` -> same gate -> YES `decideAppflow(..., scope='android')`; NO `decideAndroid`.
  - The gate is asked ONCE and remembered in progress so it does not re-prompt on resume.

- [ ] **Step 3: Restart-hides-appflow** - thread a flag (e.g. `progress.appflowExhausted` or a
  returned `hideAppflow`) so that when the appflow flow exits via "no signing material -> start over",
  the next platform-select view omits the `appflow` option. The picker (Task 6) and the
  platform-select view in the engine read this flag.

- [ ] **Step 4: Contract test** - extend `cli/test/test-appflow-flow.mjs`:

```js
// nothing-migratable submenu 'abandon' -> engine should signal hideAppflow on restart
const after = f.appflowFlow.applyInput('no-signing-submenu', { migratable:{ios:false,android:false}, noSigningScope:'all', completedSteps:[] }, { value: 'abandon' })
assert.ok(after.completedSteps.includes('no-signing-submenu'))
```

  Run: `cd cli && bun test/test-appflow-flow.mjs` -> PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd cli && bun run typecheck && bun run lint
git add cli/src/build/onboarding/mcp/engine.ts cli/test/test-appflow-flow.mjs
git commit -m "feat(onboarding): route the appflow platform through the engine (+ restart hides Appflow)"
```

---

### Task 8: Register `appflowFlow` in the flow registry

**Files:**
- Modify: the module that maps a `Platform` -> its `PlatformFlow` (the `flow/` adapter that the engine
  uses; find it by `grep -rn "iosFlow\|androidFlow" cli/src/build/onboarding/flow`).

**Interfaces:**
- Consumes: `appflowFlow` (Task 5). Produces: registry now resolves `'appflow' -> appflowFlow`.

- [ ] **Step 1: Add `appflow: appflowFlow`** to the registry map (mirror the `ios`/`android` entries).
- [ ] **Step 2: Typecheck** - `cd cli && bun run typecheck`.
- [ ] **Step 3: Commit** - `git add` the registry file; `git commit -m "feat(onboarding): register appflowFlow"`.

---

### Task 9: Step 7 validation wiring (advisory, surfaced, non-blocking)

**Files:**
- Modify: `cli/src/build/onboarding/appflow/flow.ts` (`runEffect('validate')` + `viewForStep('validate')`)
- Reuse: `android/service-account-validation.ts validateServiceAccountJson()`;
  `android/keystore.ts tryUnlockPrivateKey()` + `listKeystoreAliases()`;
  `ios/validate-app-password.ts` (Task 3); a local `.p12` open check (Node/openssl-free: decode +
  attempt parse, else skip).

**Interfaces:**
- Produces: `runValidations(progress, deps): Promise<ValidationResult[]>` where
  `ValidationResult = { id: 'sa'|'keystore'|'app-password'|'p12', status: 'pass'|'warn'|'skipped', message: string }`.
  NEVER throws; failures -> `warn`; offline/missing -> `skipped`. The view shows ALL results and a
  "continue" gate that is always enabled.

- [ ] **Step 1: Write failing test**

```js
// append to cli/test/test-appflow-flow.mjs
const results = await f.runValidations(
  { android: { PLAY_CONFIG_JSON: 'x', ANDROID_KEYSTORE_FILE: 'x', KEYSTORE_STORE_PASSWORD: 'p', KEYSTORE_KEY_ALIAS: 'a' }, ios: { FASTLANE_USER:'a@b', FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD:'w', APPLE_APP_ID:'1' }, migratable:{ios:true,android:true}, completedSteps:[] },
  { validateServiceAccountJson: async () => ({ ok: false, reason: 'bad' }), tryUnlockPrivateKey: async () => false, validateAppleAppPassword: async () => ({ valid: false, message: 'nope' }) })
assert.ok(results.every(r => ['pass','warn','skipped'].includes(r.status)))
assert.ok(results.some(r => r.status === 'warn'))            // failures became warnings
assert.ok(!results.some(r => r.status === 'block'))          // never blocks
console.log('validations advisory OK')
```

- [ ] **Step 2: Run, verify fail.** - `cd cli && bun test/test-appflow-flow.mjs` -> FAIL.

- [ ] **Step 3: Implement `runValidations`** - call each reused validator (injected via `deps` for
  testability), wrap each in try/catch, map success->`pass`, failure->`warn`, thrown/absent->`skipped`;
  return the array. `viewForStep('validate')` renders each result line (confirmation / warning /
  skipped) with a continue option that is ALWAYS present.

- [ ] **Step 4: Run, verify PASS.** "validations advisory OK".

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd cli && bun run typecheck && bun run lint
git add cli/src/build/onboarding/appflow/flow.ts cli/test/test-appflow-flow.mjs
git commit -m "feat(onboarding): advisory, surfaced, non-blocking validation for the migration"
```

---

### Task 10: Step 6 gap-fill + Step 8 p8 conversion (hand-offs to existing flows)

**Files:**
- Modify: `cli/src/build/onboarding/appflow/flow.ts` (the `*-dist-gapfill` and `p8-upgrade-prompt` steps)
- Reuse: the existing iOS p8 generate/provide steps (`asc-key/helper.ts`, `ios/flow.ts` p8 step ids)
  and the Android service-account generate/provide steps (`android/` SA flow).

**Interfaces:**
- Produces: `viewForStep('ios-dist-gapfill')` (offer generate/provide p8), `('android-dist-gapfill')`
  (offer generate/provide SA), `('p8-upgrade-prompt')` (iOS only, offer app-specific-password -> p8).
  Each delegates to the existing step ids; `applyInput` records the choice; on "provide/generate"
  the effect runs the existing helper and merges the resulting keys into `progress.ios`/`.android`.

- [ ] **Step 1: Write failing test for the view options + skip behavior**

```js
// append to cli/test/test-appflow-flow.mjs
const g = f.appflowFlow.viewForStep('p8-upgrade-prompt', { ios:{FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD:'w'}, migratable:{ios:true,android:false}, completedSteps:[] })
assert.ok(/recommended|api key|\.p8/i.test(g.prompt))
const vals = (g.options || []).map(o => o.value)
assert.ok(vals.includes('convert') && vals.includes('skip'))
console.log('gapfill + p8 conversion views OK')
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the three step views + their `applyInput`/`runEffect` delegations to the
  existing p8 / SA flows (call the same helper functions the native flows call; do not duplicate).
  All are skippable; skipping leaves `progress` unchanged and advances.
- [ ] **Step 4: Run, verify PASS.** "gapfill + p8 conversion views OK".
- [ ] **Step 5: Typecheck + lint + commit** - `git commit -m "feat(onboarding): step-6 distribution gap-fill + step-8 p8 conversion (reuse existing flows)"`.

---

### Task 11: Build + finish (skip native / skip JS build / platform-first / second / AI-email / CI-CD)

**Files:**
- Modify: `cli/src/build/onboarding/appflow/flow.ts` (`handoff-build` step + the tail invocations)
- Reuse: `tail/flow.ts` (`pick-build-script`, `requesting-build`, `ai-analysis-*`, `support-*`,
  CI/CD steps), `build-log.ts sanitizeBuildLogLines`, `ui` `FullscreenBuildOutput`,
  `workflow-generator.ts`, `ui/app.tsx handleSupport()`.

**Interfaces:**
- Produces: `viewForStep('handoff-build')` offering "Build now" / "Skip build (finish, build later)";
  a helper `platformsToBuild(progress): ('ios'|'android')[]` = platforms that BOTH have migrated creds
  AND are in `progress.scope` (a scope of `ios`/`android` restricts to that one platform); the
  build-first choice only when `scope === 'both'` AND both are present; second-platform prompt only
  after the first succeeds (and only when scope is `both`).

- [ ] **Step 1: Write failing test**

```js
// append to cli/test/test-appflow-flow.mjs
assert.deepStrictEqual(f.platformsToBuild({ scope:'both', ios:{x:'1'}, android:{}, migratable:{ios:true,android:false}, completedSteps:[] }), ['ios'])
assert.deepStrictEqual(f.platformsToBuild({ scope:'both', ios:{x:'1'}, android:{y:'1'}, migratable:{ios:true,android:true}, completedSteps:[] }).sort(), ['android','ios'])
// scope restricts even if the other platform somehow has creds
assert.deepStrictEqual(f.platformsToBuild({ scope:'ios', ios:{x:'1'}, android:{y:'1'}, migratable:{ios:true,android:true}, completedSteps:[] }), ['ios'])
const hb = f.appflowFlow.viewForStep('handoff-build', { scope:'ios', ios:{x:'1'}, migratable:{ios:true,android:false}, completedSteps:[] })
assert.ok((hb.options||[]).some(o => o.value === 'skip'))     // native build is skippable
console.log('build handoff OK')
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `platformsToBuild` + `handoff-build` (Build now vs Skip -> jump to CI/CD);
  when building, present the JS-build choice (reuse `pick-build-script`) OR a "skip JS build" option,
  then invoke the native build via the same path `tail/flow.ts` `requesting-build` uses and render the
  scrollable log; on failure offer AI/email (reuse `ai-analysis-*`/`support-*`); ask build-first only
  when both platforms present; after first success with both present, prompt for the second; end with
  the CI/CD step (reuse `workflow-generator.ts` + tail CI steps).
- [ ] **Step 4: Run, verify PASS.** "build handoff OK".
- [ ] **Step 5: Typecheck + lint + run the full new test file**

```bash
cd cli && bun run typecheck && bun run lint && bun test/test-appflow-flow.mjs
git add cli/src/build/onboarding/appflow/flow.ts cli/test/test-appflow-flow.mjs
git commit -m "feat(onboarding): build+finish (skip native/JS build, platform-first, second, AI/email, CI-CD)"
```

---

### Task 12: CLI regression wiring + run the credential-suite

**Files:**
- Modify: `cli/package.json` - register the four new `.mjs` tests in the `test` script chain
  (mirror the existing `test:credentials` style entries).

- [ ] **Step 1: Add scripts** `test:appflow-auth`, `test:appflow-api-map`, `test:appflow-validate`,
  `test:appflow-flow` (each `bun test/test-<name>.mjs`) and append them to the aggregate `test` script.
- [ ] **Step 2: Run them all** - `cd cli && bun run test:appflow-auth && bun run test:appflow-api-map && bun run test:appflow-validate && bun run test:appflow-flow` -> all PASS.
- [ ] **Step 3: Commit** - `git commit -m "test(cli): register Appflow migration unit tests"`.

---

### Task 13: e2e journeys in `Cap-go/cli-mcp-tests` (HARD REQUIREMENT - separate repo PR)

**Files (in a `Cap-go/cli-mcp-tests` worktree off origin/main):**
- Create: `cli/test/test-appflow-migration.mjs` (deterministic, run by `run-tests.sh`).
- Create: fixtures `cli/test/e2e-mcp/fixtures/appflow/*.json` from the validated probe captures
  (`appflow-token-probe.out.json`, the org/app/cert/distribution responses, and one of each
  `profiles/{tag}/credentials/{ios,android}` + `distribution-credentials/{id}?fields=...`).
- Modify: `run-tests.sh` to run the new deterministic test; add journeys to `e2e-mcp/cases.mjs`.

- [ ] **Step 1: Build fixtures** from the recorded probe outputs (secrets are test-only); a fake
  Appflow API (inject into `createAppflowApi` via a `fetchImpl`/`log` seam, mirroring how
  `appflow/api.ts` and `auth.ts` accept injected `fetch`/`openBrowser`).
- [ ] **Step 2: Write the deterministic journey assertions** covering every bullet in spec section 8
  (happy paths iOS-only/Android-only/both; auto-select single vs prompt; no-signing submenu all four
  options + neither-platform; step-6 gap-fill p8 / SA; step-7 pass/warn/skipped non-blocking;
  step-8 p8 conversion accept/decline; build-fail AI vs email; auth reuse/refresh;
  restart-hides-appflow; skip-native-build; skip-JS-build).
- [ ] **Step 3: Run** `./run-tests.sh <path-to-capgo-checkout>` and confirm green.
- [ ] **Step 4: Open the PR** to `Cap-go/cli-mcp-tests` (non-draft) and note it pairs with the capgo PR.
- [ ] **Step 5: Commit** in the cli-mcp-tests worktree; push; open PR.

---

## Self-review (done)

- Spec coverage: platform option (T6), auth (T1), org/app (T5), signing+auto-select+no-signing
  submenu (T5/T7), distribution + gap-fill (T5/T10), validation advisory/surfaced/non-blocking (T9),
  p8 conversion (T10), build skip/JS-skip/platform-first/second/AI-email/CI-CD (T11), redacted API
  trace (T2), reuse-not-merge (T5/T7/T8/T11), tests CLI+e2e (T12/T13). All sections map to a task.
- Placeholder scan: the only "mirror the existing pattern" references are integration tasks against
  named existing files with the new logic fully specified by tests; no TBD/TODO.
- Type consistency: `AppflowToken`, the Capgo key names, `AppflowStep` values, and helper names
  (`autoSelect`, `decideAfterFetchSigning`, `platformsToBuild`, `runValidations`) are consistent
  across Tasks 1-11.
