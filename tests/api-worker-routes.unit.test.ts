import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

// Exercise the production Cloudflare API entrypoint (not only the Supabase router):
// each route must be mounted and reach its own auth/validation layer instead of 404ing.
const NO_AUTH = { status: 401, error: 'no_jwt_apikey_or_subkey' }

const cases: { name: string, method: string, path: string, body?: unknown, expected: { status: number, error: string } }[] = [
  { name: 'assistant models', method: 'GET', path: '/private/assistant/models', expected: NO_AUTH },
  { name: 'assistant responses', method: 'POST', path: '/private/assistant/responses', body: { store: false, stream: true }, expected: NO_AUTH },
  ...['GET', 'POST', 'DELETE'].map(method => ({ name: `custom_domains ${method}`, method, path: '/private/custom_domains/00000000-0000-4000-8000-000000000001', expected: NO_AUTH })),
  { name: 'onboarding_ab_tests', method: 'POST', path: '/private/onboarding_ab_tests', expected: NO_AUTH },
  { name: 'onboarding_progress', method: 'POST', path: '/private/onboarding_progress', expected: NO_AUTH },
  { name: 'native_observe_stats', method: 'POST', path: '/private/native_observe_stats', body: { app_id: 'com.test.app', days: 7 }, expected: NO_AUTH },
  { name: 'observe', method: 'POST', path: '/private/observe', body: { appId: 'com.test.app', view: 'summary', days: 7 }, expected: NO_AUTH },
  // Anonymous magic-link lookup: no auth required, so it reaches body validation.
  { name: 'organization_invitation magic-lookup', method: 'POST', path: '/private/organization_invitation/magic-lookup', body: {}, expected: { status: 400, error: 'invalid_json_body' } },
  // API-key only endpoint.
  { name: 'request_manifest_upload', method: 'POST', path: '/private/request_manifest_upload', body: {}, expected: { status: 401, error: 'no_key_provided' } },
]

describe('cloudflare api worker route mounting', () => {
  it.concurrent.each(cases)('$name', async ({ method, path, body, expected }) => {
    const response = await apiWorker.fetch(new Request(`https://api.capgo.app${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }))

    expect(response.status).toBe(expected.status)
    await expect(response.json()).resolves.toMatchObject({ error: expected.error })
  })
})
