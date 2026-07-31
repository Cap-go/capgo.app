import assert from 'node:assert'
import { Buffer } from 'node:buffer'

const d = await import('../src/build/onboarding/appflow/deps.ts')

const sa = JSON.stringify({ type: 'service_account', project_id: 'x', private_key: 'k', client_email: 'a@b' })
const b64 = Buffer.from(sa, 'utf8').toString('base64')

// base64-encoded PLAY_CONFIG_JSON (the appflow + native convention) -> decoded JSON bytes
const fromB64 = d.serviceAccountJsonBytes(b64)
assert.strictEqual(fromB64.toString('utf8'), sa, 'base64 input must decode to the raw JSON')
JSON.parse(fromB64.toString('utf8')) // must be valid JSON (this is what the SA validator parses)

// already-raw JSON passes through unchanged (robustness)
const fromRaw = d.serviceAccountJsonBytes(sa)
assert.strictEqual(fromRaw.toString('utf8'), sa, 'raw JSON input must pass through as utf8')

console.log('appflow SA decode OK')
