import assert from 'node:assert/strict'
import { enableInitOtaChecklist } from '../src/init/ota-checklist.ts'
import { setCurrentCliCommand } from '../src/analytics/cli-headers.ts'

const appId = 'com.example.ota-setup'
const options = { apikey: 'fixture-key', apiHost: 'https://api.example.test', analytics: false }
const originalFetch = globalThis.fetch
const requests = []
const warnings = []
setCurrentCliCommand('init')
try {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, ...init })
    return Response.json({ onboarding: { setup: { paths: ['ota'] } } })
  }
  await enableInitOtaChecklist(appId, options, undefined, message => warnings.push(message))
  assert.equal(requests.length, 1, 'activation is a single request even with analytics disabled')
  assert.equal(requests[0].url, `https://api.example.test/app/${appId}/onboarding/ota`)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].headers.Authorization, options.apikey)
  assert.equal(requests[0].headers.capgkey, options.apikey)
  assert.equal(requests[0].headers['x-cli-command'], 'init')
  assert.deepEqual(JSON.parse(requests[0].body), {}, 'the backend owns checklist initialization')
  assert.ok(requests[0].signal instanceof AbortSignal)
  assert.deepEqual(warnings, [])

  for (const status of [404, 403, 500]) {
    globalThis.fetch = async () => Response.json({ error: 'activation_unavailable' }, { status })
    await enableInitOtaChecklist(appId, options, undefined, message => warnings.push(message))
    assert.match(warnings.at(-1), /Could not enable the OTA checklist\. Setup will continue:/)
  }
  globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError') }
  await enableInitOtaChecklist(appId, options, undefined, message => warnings.push(message))
  assert.equal(warnings.length, 4, 'unavailable servers and rejected requests warn without blocking setup')
}
finally {
  globalThis.fetch = originalFetch
  setCurrentCliCommand('')
}
console.log('OTA checklist activation uses the selected app, API host and credentials independently of analytics; errors remain non-blocking')
