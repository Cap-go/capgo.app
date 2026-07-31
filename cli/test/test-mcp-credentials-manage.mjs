#!/usr/bin/env node
/**
 * Unit + registration test for the `capgo_builder_credentials_manage` MCP tool.
 *
 * Drives the REAL runCredentialsManage / registerCredentialsManageTool against an
 * in-memory fake credential store. Pins the agent-facing contract:
 *   - refuses (→ onboarding) when NO credentials exist for the app
 *   - refuses (→ onboarding) when the TARGET PLATFORM has no credentials yet
 *   - export → .env, set → add/edit (value or base64 from valueFile), remove → delete (one field)
 *   - secret VALUES never appear in tool output (list = names only; set = no echo)
 *   - the tool description steers the model to onboarding when credentials are absent
 */
import process from 'node:process'

console.log('🧪 Testing capgo_builder_credentials_manage...\n')

const { safeParseSchema } = await import('../src/schemas/schema_validation.ts')
const { runCredentialsManage, registerCredentialsManageTool, credentialsManageSchema, KNOWN_CREDENTIAL_KEYS, screenValueFilePath, screenExportPath } = await import('../src/build/onboarding/mcp/credentials-manage.ts')
const { homedir } = await import('node:os')
const { join } = await import('node:path')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }
function has(text, sub, msg) { if (!String(text).includes(sub)) throw new Error(msg || `expected text to contain ${JSON.stringify(sub)} — got: ${String(text).slice(0, 250)}`) }
function lacks(text, sub, msg) { if (String(text).includes(sub)) throw new Error(msg || `expected text to NOT contain ${JSON.stringify(sub)} — got: ${String(text).slice(0, 250)}`) }

// In-memory fake credential store + call recorder.
function makeDeps(opts = {}) {
  const appId = Object.prototype.hasOwnProperty.call(opts, 'appId') ? opts.appId : 'com.acme.app'
  const store = opts.store ?? {} // { [appId]: { ios?: {...}, android?: {...} } }
  const files = opts.files ?? {} // { [path]: 'rawbytes' } → readFileBase64 returns base64(rawbytes)
  const state = { updates: [], removes: [], exports: [], reads: [], exportResult: opts.exportResult ?? null }
  const deps = {
    getAppId: async () => appId,
    loadSavedCredentials: async id => store[id] ?? null,
    updateSavedCredentials: async (id, platform, creds, local) => {
      state.updates.push({ id, platform, creds, local })
      store[id] = store[id] ?? {}
      store[id][platform] = { ...store[id][platform], ...creds }
    },
    removeSavedCredentialKeys: async (id, platform, keys, local) => {
      state.removes.push({ id, platform, keys, local })
      if (store[id]?.[platform]) for (const k of keys) delete store[id][platform][k]
    },
    exportCredentialsToEnv: (o) => {
      state.exports.push(o)
      if (state.exportResult) return state.exportResult
      const fieldCount = Object.values(o.credentials).filter(v => typeof v === 'string' && v.length > 0).length
      return { kind: 'written', path: o.targetPath ?? `/proj/.env.capgo.${o.appId}.${o.platform}`, fieldCount }
    },
    readFileBase64: async (p) => {
      state.reads.push(p)
      if (!(p in files)) throw new Error('ENOENT')
      return Buffer.from(files[p]).toString('base64')
    },
    localCredentialsExist: async () => opts.local ?? false,
  }
  return { deps, state, store }
}

const ANDROID = { KEYSTORE_STORE_PASSWORD: 'pw', KEYSTORE_KEY_ALIAS: 'release', ANDROID_KEYSTORE_FILE: 'AAAA' }

// ── App-level gate: no credentials at all → onboarding ────────────────────────
await test('no credentials for the app → refuses and points at onboarding', async () => {
  const { deps, state } = makeDeps({ store: {} })
  const out = await runCredentialsManage({ action: 'list' }, deps)
  has(out, 'No saved Capgo Builder credentials')
  has(out, 'start_capgo_builder_onboarding')
  ok(state.updates.length === 0 && state.removes.length === 0, 'no mutations')
})

await test('empty platforms object also counts as no credentials', async () => {
  const { deps } = makeDeps({ store: { 'com.acme.app': {} } })
  has(await runCredentialsManage({ action: 'export', platform: 'android' }, deps), 'start_capgo_builder_onboarding')
})

await test('no app id (and none passed) → graceful error, no mutation', async () => {
  const { deps, state } = makeDeps({ appId: undefined, store: {} })
  has(await runCredentialsManage({ action: 'list' }, deps), 'Could not determine the app id')
  ok(state.updates.length === 0)
})

// ── Platform-level gate: editing a not-set-up platform → onboarding (journey 2) ─
await test('set/export/remove on a platform with NO credentials → insist on onboarding that platform', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } }) // ios NOT set up
  for (const input of [
    { action: 'set', platform: 'ios', key: 'P12_PASSWORD', value: 'x' },
    { action: 'export', platform: 'ios' },
    { action: 'remove', platform: 'ios', key: 'P12_PASSWORD' },
  ]) {
    const out = await runCredentialsManage(input, deps)
    has(out, 'No ios credentials exist', `${input.action} should refuse a not-set-up platform`)
    has(out, 'start_capgo_builder_onboarding', `${input.action} should redirect to onboarding`)
  }
  ok(state.updates.length === 0 && state.removes.length === 0 && state.exports.length === 0, 'no mutations on a not-set-up platform')
})

// ── list ──────────────────────────────────────────────────────────────────────
await test('list shows field NAMES per platform but never values', async () => {
  const { deps } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  const out = await runCredentialsManage({ action: 'list' }, deps)
  has(out, 'android:')
  has(out, 'KEYSTORE_STORE_PASSWORD')
  lacks(out, 'AAAA', 'never leaks the keystore value')
  lacks(out, '"pw"', 'never leaks the password value')
})

// ── export ──────────────────────────────────────────────────────────────────────
await test('export writes a .env and reports the path + field count', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  const out = await runCredentialsManage({ action: 'export', platform: 'android' }, deps)
  ok(state.exports.length === 1 && state.exports[0].platform === 'android')
  has(out, 'Exported')
  has(out, '.env.capgo.com.acme.app.android')
  has(out, '0600')
})

await test('export onto an existing file → tells the agent to pass overwrite', async () => {
  const { deps } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } }, exportResult: { kind: 'exists', path: '/proj/.env.x' } })
  const out = await runCredentialsManage({ action: 'export', platform: 'android' }, deps)
  has(out, 'already exists')
  has(out, 'overwrite:true')
})

await test('export without platform → asks for one', async () => {
  const { deps } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  has(await runCredentialsManage({ action: 'export' }, deps), 'needs a platform')
})

// ── set (add / edit) ──────────────────────────────────────────────────────────
await test('set adds/edits a field via updateSavedCredentials and does NOT echo the value', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  const out = await runCredentialsManage({ action: 'set', platform: 'android', key: 'KEYSTORE_KEY_PASSWORD', value: 'SUPER_SECRET_VALUE' }, deps)
  ok(state.updates.length === 1 && state.updates[0].creds.KEYSTORE_KEY_PASSWORD === 'SUPER_SECRET_VALUE')
  has(out, 'Set KEYSTORE_KEY_PASSWORD')
  lacks(out, 'SUPER_SECRET_VALUE', 'must NOT echo the secret value back')
})

await test('set with valueFile base64-encodes the file (keystore replacement — journey 3)', async () => {
  const { deps, state } = makeDeps({
    store: { 'com.acme.app': { android: { ...ANDROID } } },
    files: { '/tmp/new.keystore': 'BINARYKEYSTOREBYTES' },
  })
  const out = await runCredentialsManage({ action: 'set', platform: 'android', key: 'ANDROID_KEYSTORE_FILE', valueFile: '/tmp/new.keystore' }, deps)
  ok(state.reads[0] === '/tmp/new.keystore', 'read the provided file')
  ok(state.updates[0].creds.ANDROID_KEYSTORE_FILE === Buffer.from('BINARYKEYSTOREBYTES').toString('base64'), 'stored base64 of the file')
  has(out, 'Set ANDROID_KEYSTORE_FILE')
  has(out, 'from /tmp/new.keystore')
})

await test('set with an unreadable valueFile → error, no mutation', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } }, files: {} })
  const out = await runCredentialsManage({ action: 'set', platform: 'android', key: 'ANDROID_KEYSTORE_FILE', valueFile: '/nope.keystore' }, deps)
  has(out, 'Could not read the file')
  ok(state.updates.length === 0)
})

// ── valueFile / export path screening (security — the caller is an untrusted LLM) ─
await test('screenValueFilePath rejects non-credential extensions (SSH keys, /etc/passwd, no-ext secrets)', async () => {
  for (const p of ['/Users/x/.ssh/id_ed25519', '/etc/passwd', '/Users/x/.aws/credentials', '/Users/x/notes.txt'])
    ok(screenValueFilePath(p), `should refuse ${p}`)
  ok(!screenValueFilePath('/Users/x/Downloads/release.keystore'), 'allows a .keystore')
  ok(!screenValueFilePath('/tmp/play.json'), 'allows a .json service account')
})

await test('screenValueFilePath rejects credential-extension files inside sensitive dirs', async () => {
  has(screenValueFilePath(join(homedir(), '.capgo-credentials', 'credentials.json')), 'sensitive directory')
  has(screenValueFilePath(join(homedir(), '.config', 'gcloud', 'application_default_credentials.json')), 'sensitive directory')
  has(screenValueFilePath(join(homedir(), '.ssh', 'key.pem')), 'sensitive directory')
})

await test('set refuses a valueFile outside the credential-file allow-list — no read, no mutation', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } }, files: { '/Users/x/.ssh/id_ed25519': 'PRIVATEKEY' } })
  const out = await runCredentialsManage({ action: 'set', platform: 'android', key: 'ANDROID_KEYSTORE_FILE', valueFile: '/Users/x/.ssh/id_ed25519' }, deps)
  has(out, 'Refusing to read')
  ok(state.reads.length === 0, 'never read the file')
  ok(state.updates.length === 0, 'never mutated the store')
})

await test('screenExportPath keeps the .env inside the project dir', async () => {
  const proj = '/Users/x/proj'
  ok(!screenExportPath('.env.capgo.app.android', proj), 'allows a file in the project')
  ok(!screenExportPath('sub/dir/.env', proj), 'allows a nested file in the project')
  ok(screenExportPath('/etc/cron.d/capgo', proj), 'refuses /etc/cron.d')
  ok(screenExportPath('../../../../etc/passwd', proj), 'refuses traversal out of the project')
})

await test('set/remove write to the LOCAL store when a project-local store wins the load', async () => {
  const g = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } }, local: true })
  await runCredentialsManage({ action: 'set', platform: 'android', key: 'KEYSTORE_STORE_PASSWORD', value: 'x' }, g.deps)
  ok(g.state.updates[0].local === true, 'set passed local:true')
  await runCredentialsManage({ action: 'remove', platform: 'android', key: 'KEYSTORE_KEY_ALIAS' }, g.deps)
  ok(g.state.removes[0].local === true, 'remove passed local:true')
  // default (no local store) → writes global
  const gg = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  await runCredentialsManage({ action: 'set', platform: 'android', key: 'KEYSTORE_STORE_PASSWORD', value: 'x' }, gg.deps)
  ok(gg.state.updates[0].local === false, 'set passed local:false when no local store')
})

await test('set with an unknown key → still saves but warns about the field name', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  has(await runCredentialsManage({ action: 'set', platform: 'android', key: 'NOT_A_REAL_FIELD', value: 'x' }, deps), 'not a standard Capgo credential field')
  ok(state.updates.length === 1)
})

await test('set missing key / value → explicit errors, no mutation', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  has(await runCredentialsManage({ action: 'set', platform: 'android', value: 'x' }, deps), 'needs a key')
  has(await runCredentialsManage({ action: 'set', platform: 'android', key: 'K' }, deps), 'needs a value')
  ok(state.updates.length === 0)
})

await test('KNOWN_CREDENTIAL_KEYS includes the real fields', async () => {
  for (const k of ['KEYSTORE_STORE_PASSWORD', 'ANDROID_KEYSTORE_FILE', 'PLAY_CONFIG_JSON', 'P12_PASSWORD']) ok(KNOWN_CREDENTIAL_KEYS.has(k), `missing ${k}`)
})

// ── remove ──────────────────────────────────────────────────────────────────────
await test('remove deletes an existing field', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  const out = await runCredentialsManage({ action: 'remove', platform: 'android', key: 'KEYSTORE_KEY_ALIAS' }, deps)
  ok(state.removes.length === 1 && state.removes[0].keys[0] === 'KEYSTORE_KEY_ALIAS')
  has(out, 'Removed KEYSTORE_KEY_ALIAS')
})

await test('remove a field that is not set → nothing to remove, no mutation', async () => {
  const { deps, state } = makeDeps({ store: { 'com.acme.app': { android: { ...ANDROID } } } })
  has(await runCredentialsManage({ action: 'remove', platform: 'android', key: 'MISSING' }, deps), 'Nothing to remove')
  ok(state.removes.length === 0)
})

// ── registration ──────────────────────────────────────────────────────────────
await test('registerCredentialsManageTool registers the tool with the right name + schema', async () => {
  const tools = {}
  const server = { registerTool: (name, config, handler) => { tools[name] = { desc: config.description, schema: config.inputSchema, handler } } }
  registerCredentialsManageTool(server, async () => 'com.acme.app')
  ok(tools.capgo_builder_credentials_manage, 'registers capgo_builder_credentials_manage')
  ok(tools.capgo_builder_credentials_manage.schema === credentialsManageSchema)
  ok(safeParseSchema(credentialsManageSchema, { action: 'set', platform: 'android', key: 'ANDROID_KEYSTORE_FILE', valueFile: '/tmp/test.jks' }).success, 'schema accepts valueFile')
})

await test('tool description steers the model to onboarding when no creds exist', async () => {
  const tools = {}
  const server = { registerTool: (name, config, handler) => { tools[name] = { desc: config.description, handler } } }
  registerCredentialsManageTool(server, async () => 'com.acme.app')
  const { desc } = tools.capgo_builder_credentials_manage
  has(desc, 'start_capgo_builder_onboarding')
  has(desc, 'ALREADY')
  has(desc.toLowerCase(), 'never')
})

await test('registered handler returns an MCP text block from runCredentialsManage', async () => {
  const tools = {}
  const server = { registerTool: (name, _config, handler) => { tools[name] = handler } }
  const { deps } = makeDeps({ store: {} })
  registerCredentialsManageTool(server, deps.getAppId, deps)
  const res = await tools.capgo_builder_credentials_manage({ action: 'list' })
  ok(res && Array.isArray(res.content) && res.content[0].type === 'text')
  has(res.content[0].text, 'start_capgo_builder_onboarding')
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
