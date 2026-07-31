// Regression coverage for the credential-acquisition effects that the hostile
// review flagged: org/app fetch + auto-select (C2/C5/C26), multi-cert selection
// storing the tag and NOT looping (C1/C6/C16), multi-distribution selection
// (C8/C12), and the API client HARD-FAILING on non-2xx (C3/C4/C18/C28).
//
// The effects build their own Appflow API client over global fetch, so we mock
// globalThis.fetch with a per-test router.
import assert from 'node:assert'

const f = await import('../src/build/onboarding/appflow/flow.ts')
const api = await import('../src/build/onboarding/appflow/api.ts')

const realFetch = globalThis.fetch
function mockFetch(router) {
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const op = init?.body ? (() => { try { return JSON.parse(init.body).operationName } catch { return undefined } })() : undefined
    const r = router({ url: u, op, init })
    const status = r.status ?? 200
    const bodyText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return bodyText },
      async json() { return JSON.parse(bodyText) },
    }
  }
}
function restore() { globalThis.fetch = realFetch }

const baseProgress = (over = {}) => ({ scope: 'ios', token: { access_token: 't' }, migratable: { ios: false, android: false }, completedSteps: ['explain', 'authenticating'], ...over })

// ── fetch-orgs: 0 orgs -> THROWS (no orgs is a loud, surfaced error) ──
mockFetch(({ op }) => op === 'BootstrapApp' ? { body: { data: { viewer: { organizations: { edges: [] } } } } } : { body: { data: {} } })
await assert.rejects(() => f.appflowFlow.runEffect('fetch-orgs', baseProgress({ scope: 'ios' }), { log() {} }), /no appflow organizations/i)
restore()

// ── fetch-orgs: exactly ONE org -> auto-select + advance to fetch-apps (no prompt) ──
mockFetch(({ op }) => op === 'BootstrapApp' ? { body: { data: { viewer: { organizations: { edges: [{ node: { slug: 'only-org', name: 'Only Org' } }] } } } } } : { body: { data: {} } })
{
  const r = await f.appflowFlow.runEffect('fetch-orgs', baseProgress({ scope: 'ios' }), { log() {} })
  assert.strictEqual(r.progress.orgSlug, 'only-org', 'single org auto-selected')
  assert.strictEqual(r.next, 'fetch-apps', 'advances to fetch-apps')
}
restore()

// ── fetch-orgs: 2+ orgs -> prompt with REAL options + mark done (so resume routes to select-org, not a loop) ──
mockFetch(({ op }) => op === 'BootstrapApp'
  ? { body: { data: { viewer: { organizations: { edges: [{ node: { slug: 'a', name: 'Org A' } }, { node: { slug: 'b', name: 'Org B' } }] } } } } }
  : { body: { data: {} } })
{
  const r = await f.appflowFlow.runEffect('fetch-orgs', baseProgress({ scope: 'ios' }), { log() {} })
  assert.strictEqual(r.next, 'select-org')
  assert.deepStrictEqual(r.transient.options.map(o => o.value), ['a', 'b'], 'real options surfaced')
  assert.ok(r.progress.completedSteps.includes('fetch-orgs'), 'fetch-orgs marked done')
  // resume now routes to the prompt (not back to fetch-orgs)
  assert.strictEqual(f.getAppflowResumeStep(r.progress), 'select-org')
  // user picks 'b' -> orgSlug stored, resume routes to fetch-apps
  const picked = f.appflowFlow.applyInput('select-org', r.progress, { value: 'b' })
  assert.strictEqual(picked.orgSlug, 'b')
  assert.strictEqual(f.getAppflowResumeStep(picked), 'fetch-apps')
}
restore()

// ── fetch-apps: ONE app -> auto-select id+slug + advance to fetch-signing ──
mockFetch(({ op }) => op === 'OrganizationApps'
  ? { body: { data: { organization: { apps: { edges: [{ node: { id: 'app-1', name: 'My App', slug: 'my-app' } }] } } } } }
  : { body: { data: {} } })
{
  const r = await f.appflowFlow.runEffect('fetch-apps', baseProgress({ scope: 'ios', orgSlug: 'o', completedSteps: ['explain', 'authenticating', 'fetch-orgs'] }), { log() {} })
  assert.strictEqual(r.progress.appId, 'app-1')
  assert.strictEqual(r.progress.appSlug, 'my-app')
  assert.strictEqual(r.next, 'fetch-signing')
}
restore()

// ── fetch-apps: 2+ apps -> prompt + done; pick stores appId, resume -> fetch-signing ──
mockFetch(({ op }) => op === 'OrganizationApps'
  ? { body: { data: { organization: { apps: { edges: [{ node: { id: 'a1', name: 'A1', slug: 's1' } }, { node: { id: 'a2', name: 'A2', slug: 's2' } }] } } } } }
  : { body: { data: {} } })
{
  const r = await f.appflowFlow.runEffect('fetch-apps', baseProgress({ scope: 'ios', orgSlug: 'o', completedSteps: ['explain', 'authenticating', 'fetch-orgs'] }), { log() {} })
  assert.strictEqual(r.next, 'select-app')
  assert.deepStrictEqual(r.transient.options.map(o => o.value), ['a1', 'a2'])
  const picked = f.appflowFlow.applyInput('select-app', r.progress, { value: 'a2', text: 's2' })
  assert.strictEqual(picked.appId, 'a2')
  assert.strictEqual(f.getAppflowResumeStep(picked), 'fetch-signing')
}
restore()

// ── fetch-signing: 2+ iOS certs -> prompt ONCE, mark done; stored tag downloads THAT cert, NO loop ──
const twoIosCerts = { data: { app: { certificates: { edges: [
  { node: { tag: 'tag-A', name: 'Cert A', type: 'development', credentials: { ios: {} } } },
  { node: { tag: 'tag-B', name: 'Cert B', type: 'distribution', credentials: { ios: {} } } },
] } } } }
mockFetch(({ op, url }) => {
  if (op === 'GetDataForPackageCerts')
    return { body: twoIosCerts }
  if (url.includes('/profiles/tag-B/credentials/ios'))
    return { body: { data: { cert_file: 'data:application/x-pkcs12;base64,Q0VSVA==', cert_password: 'pw' } } }
  return { body: { data: {} } }
})
{
  const start = baseProgress({ scope: 'ios', orgSlug: 'o', appId: 'app-1', completedSteps: ['explain', 'authenticating', 'fetch-orgs', 'fetch-apps'] })
  const r1 = await f.appflowFlow.runEffect('fetch-signing', start, { log() {} })
  assert.strictEqual(r1.next, 'select-ios-cert', 'prompts on 2+ certs')
  assert.ok(r1.progress.completedSteps.includes('fetch-signing'), 'fetch-signing marked done UP FRONT (no livelock)')
  assert.deepStrictEqual(r1.transient.options.map(o => o.value), ['tag-A', 'tag-B'])
  // user picks tag-B -> stored
  const picked = f.appflowFlow.applyInput('select-ios-cert', r1.progress, { value: 'tag-B' })
  assert.strictEqual(picked.iosCertTag, 'tag-B', 'chosen cert tag stored')
  // resume does NOT route back to a re-prompt: fetch-signing is done, so the
  // resume router moves on (the chosen tag is consumed by re-running the effect)
  // Re-run the effect (driver re-enters fetch-signing once to download): stored
  // tag drives fetchIosSigning(tag-B), NO further prompt.
  const r2 = await f.appflowFlow.runEffect('fetch-signing', picked, { log() {} })
  assert.notStrictEqual(r2.next, 'select-ios-cert', 'no re-prompt on re-entry with stored tag')
  assert.strictEqual(r2.progress.ios.BUILD_CERTIFICATE_BASE64, 'Q0VSVA==', 'downloaded the CHOSEN cert')
}
restore()

// ── single iOS scope: 2+ iOS certs -> prompt; android certs ignored (out of scope) ──
const iosCerts = { data: { app: { certificates: { edges: [
  { node: { tag: 'i-A', credentials: { ios: {} } } },
  { node: { tag: 'i-B', credentials: { ios: {} } } },
  { node: { tag: 'a-1', credentials: { android: {} } } },
] } } } }
mockFetch(({ op }) => op === 'GetDataForPackageCerts' ? { body: iosCerts } : { body: { data: {} } })
{
  // iOS chosen already (i-B); android certs are out of scope and never migratable.
  const start = baseProgress({ scope: 'ios', orgSlug: 'o', appId: 'app-1', iosCertTag: 'i-B', completedSteps: ['explain', 'authenticating', 'fetch-orgs', 'fetch-apps'] })
  const r = await f.appflowFlow.runEffect('fetch-signing', start, { log() {} })
  assert.ok(r.progress.migratable.ios && !r.progress.migratable.android, 'iOS migratable, Android out of scope')
  assert.notStrictEqual(r.next, 'select-ios-cert')
}
restore()

// ── fetch-distribution: 2+ iOS dist creds -> prompt (NOT silently dropped) ──
mockFetch(({ url }) => {
  if (url.includes('/distribution-credentials') && !url.match(/distribution-credentials\/\d/))
    return { body: { data: [{ id: 11, type: 'iTunes connect' }, { id: 12, type: 'iTunes connect' }] } }
  if (url.includes('/distribution-credentials/12'))
    return { body: { data: { user_name: 'u', app_specific_password: 'w', apple_app_id: 5, team_id: 'T' } } }
  return { body: { data: {} } }
})
{
  const start = baseProgress({ scope: 'ios', orgSlug: 'o', appId: 'app-1', ios: { BUILD_CERTIFICATE_BASE64: 'x' }, migratable: { ios: true, android: false }, completedSteps: ['explain', 'authenticating', 'fetch-orgs', 'fetch-apps', 'fetch-signing'] })
  const r1 = await f.appflowFlow.runEffect('fetch-distribution', start, { log() {} })
  assert.strictEqual(r1.next, 'select-ios-dist', '2+ dist creds prompt instead of dropping')
  assert.ok(r1.progress.completedSteps.includes('fetch-distribution'))
  assert.deepStrictEqual(r1.transient.options.map(o => o.value), ['11', '12'])
  const picked = f.appflowFlow.applyInput('select-ios-dist', r1.progress, { value: '12' })
  assert.strictEqual(picked.iosDistId, '12')
  const r2 = await f.appflowFlow.runEffect('fetch-distribution', picked, { log() {} })
  assert.notStrictEqual(r2.next, 'select-ios-dist', 'no re-prompt with stored id')
  assert.strictEqual(r2.progress.ios.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD, 'w', 'downloaded chosen dist cred')
}
restore()

// ── API client HARD-FAILS on non-2xx: fetch-signing surfaces an ERROR (not "no signing") ──
mockFetch(({ op }) => op === 'GetDataForPackageCerts' ? { status: 401, body: { error: { message: 'token expired' } } } : { status: 401, body: {} })
{
  const start = baseProgress({ scope: 'ios', orgSlug: 'o', appId: 'app-1', completedSteps: ['explain', 'authenticating', 'fetch-orgs', 'fetch-apps'] })
  await assert.rejects(() => f.appflowFlow.runEffect('fetch-signing', start, { log() {} }), /401|token expired/i, 'non-2xx throws, not collapsed to []')
}
restore()

// ── direct AppflowApiError on REST + GraphQL non-2xx and GraphQL errors payload ──
mockFetch(() => ({ status: 500, body: { message: 'boom' } }))
{
  const a = api.createAppflowApi('t', () => {})
  await assert.rejects(() => a.listDistribution('app-1'), /500/i)
  await assert.rejects(() => a.listOrgs(), /500/i)
}
restore()
mockFetch(({ op }) => op === 'BootstrapApp' ? { status: 200, body: { errors: [{ message: 'not authorized' }] } } : { body: {} })
{
  const a = api.createAppflowApi('t', () => {})
  await assert.rejects(() => a.listOrgs(), /not authorized|errors/i, 'GraphQL errors payload throws')
}
restore()

console.log('appflow fetch/effect regression OK')
