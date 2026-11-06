import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/config_builder.ts'

beforeEach(() => {
  // Establish a clean baseline so tests don't leak state from each other or
  // from an actual GOOGLE_OAUTH_* set in the dev environment.
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '')
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '')
  vi.stubEnv('GOOGLE_OAUTH_SCOPES', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function get(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env))
    vi.stubEnv(k, v)
  return app.request('http://local/', { method: 'GET' })
}

describe('get /private/config/builder', () => {
  it('returns enabled:true with clientId, clientSecret, and default scopes when both required env vars are set', async () => {
    const response = await get({
      GOOGLE_OAUTH_CLIENT_ID: '1234.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-abc',
    })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({
      enabled: true,
      clientId: '1234.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-abc',
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    })
  })

  it.each([
    ['neither required env var is set', {}],
    ['only GOOGLE_OAUTH_CLIENT_ID is set', { GOOGLE_OAUTH_CLIENT_ID: '1234.apps.googleusercontent.com' }],
    ['only GOOGLE_OAUTH_CLIENT_SECRET is set', { GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-abc' }],
    ['both env vars are whitespace-only', { GOOGLE_OAUTH_CLIENT_ID: '   ', GOOGLE_OAUTH_CLIENT_SECRET: '\t\n' }],
  ])('returns only enabled:false when %s', async (_label, env) => {
    const response = await get(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false })
  })

  it.each([
    ['uses a custom single scope', 'https://www.googleapis.com/auth/cloud-platform', ['https://www.googleapis.com/auth/cloud-platform']],
    [
      'parses comma-separated scopes and trims each entry',
      ' https://www.googleapis.com/auth/androidpublisher , https://www.googleapis.com/auth/cloud-platform ',
      ['https://www.googleapis.com/auth/androidpublisher', 'https://www.googleapis.com/auth/cloud-platform'],
    ],
    ['falls back to the default scope when GOOGLE_OAUTH_SCOPES has no non-empty entries', ' , , ', ['https://www.googleapis.com/auth/androidpublisher']],
  ])('%s', async (_label, scopes, expected) => {
    const response = await get({ GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csec', GOOGLE_OAUTH_SCOPES: scopes })

    expect(response.status).toBe(200)
    expect((await response.json() as { scopes: string[] }).scopes).toEqual(expected)
  })
})
