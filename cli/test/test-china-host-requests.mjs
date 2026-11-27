#!/usr/bin/env node

// With the China API host configured, no CLI request may reach a *.capgo.app host:
// those hosts time out from mainland China (Cap-go capgo CLI 8.113.0 to 8.114.1).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chdir, cwd } from 'node:process'
import { getUpdateUrl } from '../src/app/updateProbe.ts'
import { runCapgoAiAnalysis } from '../src/ai/analyze.ts'
import { getLogCapturePath } from '../src/ai/log-capture.ts'
import { fetchCapgoOAuthConfig } from '../src/build/onboarding/android/oauth-config.ts'
import { createBrokerSession, pollBrokerSession } from '../src/build/onboarding/mcp/broker-oauth.ts'
import { runOnboardingCheck } from '../src/onboarding/background-check.ts'
import { isTrustedOnboardingApiHost } from '../src/onboarding/background-api.ts'
import { prepareOnboardingCheck } from '../src/onboarding/background-preparation.ts'
import { readSetupProgress } from '../src/onboarding/setup-notice-evaluation.ts'
import { uploadSupportLogs } from '../src/support/support-upload.ts'
import { defaultApiHost, getRemoteConfig, getRemoteFileConfig, invokeCapgoCliApi, pickCapgoApiHost, sendEvent } from '../src/utils.ts'

const CHINA_API = 'https://api.capgo.com.cn'
const CHINA_CONSOLE = 'https://console.capgo.com.cn'

const originalFetch = globalThis.fetch
const originalCwd = cwd()
const savedEnv = {}
for (const name of ['CAPGO_API_HOST', 'CAPGO_FILES_HOST', 'CAPGO_BUILDER_CONFIG_URL', 'CAPGO_OAUTH_BROKER_URL', 'CAPGO_TRUSTED_API_ORIGINS', 'CAPGO_DISABLE_TELEMETRY', 'CAPGO_DISABLE_POSTHOG']) {
  savedEnv[name] = process.env[name]
  delete process.env[name]
}

const requests = []
function respond(url) {
  const path = new URL(url).pathname
  if (path.endsWith('/private/config/builder'))
    return { enabled: true, clientId: 'id', clientSecret: 'secret', scopes: ['scope'] }
  if (path.endsWith('/builder_auth_direct/google/sessions'))
    return { pub_id: 'pub', poll_secret: 'secret', sign_in_url: `${CHINA_API}/builder_auth_direct/google/start?s=pub`, expires_at: 1 }
  if (path.includes('/builder_auth_direct/google/sessions/'))
    return { status: 'pending' }
  if (path.endsWith('/build/support_logs'))
    return { id: 'a'.repeat(64), url: `${CHINA_API}/builder_support_logs/${'a'.repeat(64)}` }
  if (path.endsWith('/private/onboarding_progress'))
    return { onboarding: {} }
  return {}
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  requests.push({ url, method: init?.method ?? 'GET' })
  if (new URL(url).pathname.endsWith('/build/ai_analyze_stream')) {
    return new Response('data: {"type":"done","analysis":"ok"}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  return new Response(JSON.stringify(respond(url)), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function assertOnlyChinaHost(label) {
  assert.ok(requests.length > 0, `${label}: expected at least one request`)
  for (const { url } of requests) {
    const { hostname, origin } = new URL(url)
    assert.equal(hostname === 'capgo.app' || hostname.endsWith('.capgo.app'), false, `${label}: request leaked to ${url}`)
    assert.equal(origin, CHINA_API, `${label}: request went to ${url} instead of the China host`)
  }
  requests.length = 0
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'capgo-china-host-')))
try {
  // Host precedence used by background workers mirrors getLocalConfig.
  assert.equal(pickCapgoApiHost({}), defaultApiHost)
  assert.equal(pickCapgoApiHost({ localApi: 'https://self.example.com' }), 'https://self.example.com')
  assert.equal(pickCapgoApiHost({ env: `${CHINA_API}/`, localApi: 'https://self.example.com' }), CHINA_API)
  assert.equal(pickCapgoApiHost({ explicit: 'https://cli.example.com', env: CHINA_API }), 'https://cli.example.com')
  assert.equal(isTrustedOnboardingApiHost(CHINA_API, {}, []), true, 'the China API is first party Capgo cloud')
  assert.equal(isTrustedOnboardingApiHost('https://api.capgo.com.cn.example.com', {}, []), false)

  // A Capacitor app without any host config: only CAPGO_API_HOST selects China.
  const appDir = join(root, 'app')
  mkdirSync(join(appDir, 'src'), { recursive: true })
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'china-app', version: '1.0.0' }))
  writeFileSync(join(appDir, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.china', appName: 'China', webDir: 'dist' }))
  chdir(appDir)
  process.env.CAPGO_API_HOST = CHINA_API

  // Background onboarding worker that runs during `bundle upload` (the api.capgo.app calls seen in the strace).
  const prepared = await prepareOnboardingCheck({ cwd: appDir, command: 'bundle upload', apikey: 'test-key', setupNotice: true })
  assert.ok(prepared, 'onboarding check must still run for China users')
  assert.equal(prepared.apiHost, CHINA_API)
  assert.equal(prepared.webHost, CHINA_CONSOLE)
  await readSetupProgress(prepared)
  await runOnboardingCheck({ ...prepared, attemptId: 'attempt' }, { channel: 'notify-app-ready', step: 'add_code', scan: () => 'found' })
  await sendEvent('test-key', { channel: 'onboarding', event: 'test' }, false, undefined, prepared.apiHost)
  assertOnlyChinaHost('background onboarding')

  // China apps that point their updater at the China host keep onboarding on the China host.
  writeFileSync(join(appDir, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.china', appName: 'China', webDir: 'dist', plugins: { CapacitorUpdater: { updateUrl: `${CHINA_API}/updates`, localApi: CHINA_API } } }))
  delete process.env.CAPGO_API_HOST
  const fromConfig = await prepareOnboardingCheck({ cwd: appDir, command: 'bundle upload', apikey: 'test-key' })
  assert.equal(fromConfig?.apiHost, CHINA_API)
  process.env.CAPGO_API_HOST = CHINA_API
  writeFileSync(join(appDir, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.china', appName: 'China', webDir: 'dist' }))

  // Core bundle upload calls: remote config, files config, CLI API, events.
  await getRemoteConfig(true, undefined, 'test-key')
  await getRemoteFileConfig('test-key')
  await invokeCapgoCliApi('private/cli/channels?app_id=com.example.china', { apikey: 'test-key', method: 'GET' })
  await invokeCapgoCliApi('files/upload_link', { apikey: 'test-key', method: 'POST', useFilesHost: true })
  await sendEvent('test-key', { channel: 'app', event: 'test' })
  assertOnlyChinaHost('bundle upload core calls')

  // Builder: Google OAuth client config (/private/config/builder) and the MCP OAuth broker.
  assert.ok(await fetchCapgoOAuthConfig())
  await createBrokerSession('com.example.china')
  await pollBrokerSession({ pubId: 'pub', pollSecret: 'secret' })
  assertOnlyChinaHost('builder config and broker')

  // Support log upload and AI analysis called from the onboarding UI without an explicit --api-host.
  const gzPath = join(root, 'logs.gz')
  writeFileSync(gzPath, 'logs')
  assert.ok(await uploadSupportLogs({ apikey: 'test-key', appId: 'com.example.china', gzPath }))
  const jobId = `china-host-${process.pid}`
  mkdirSync(join(getLogCapturePath(jobId), '..'), { recursive: true })
  writeFileSync(getLogCapturePath(jobId), 'build failed\n')
  try {
    await runCapgoAiAnalysis({ apikey: 'test-key', jobId, appId: 'com.example.china' })
  }
  finally {
    rmSync(getLogCapturePath(jobId), { force: true })
  }
  assertOnlyChinaHost('support upload and AI analysis')

  // Update probe defaults to the China updates route, unless the app configures its own.
  assert.equal(getUpdateUrl({}, CHINA_API), `${CHINA_API}/updates`)
  assert.equal(getUpdateUrl({}, defaultApiHost), 'https://plugin.capgo.app/updates')
  assert.equal(getUpdateUrl({ plugins: { CapacitorUpdater: { updateUrl: 'https://updates.example.com' } } }, CHINA_API), 'https://updates.example.com')

  console.log('china host requests: ok')
}
finally {
  globalThis.fetch = originalFetch
  chdir(originalCwd)
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined)
      delete process.env[name]
    else
      process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
}
