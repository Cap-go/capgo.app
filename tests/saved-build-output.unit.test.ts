import { describe, expect, it, vi } from 'vitest'
import { pickSavedOutput, savedOutputsForJobs } from '../supabase/functions/_backend/public/build/outputs.ts'

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({
    query: async (_sql: string, params: [string, string, string[]]) => ({ rows: params[2].map(id => ({ builder_job_id: id, platform: 'ios' })) }),
  }),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ getEnv: () => 'https://builder.example' }))

describe('saved native build output', () => {
  const expiresAt = Date.parse('2099-01-01T00:00:00.000Z')
  const ipa = { kind: 'ios_ipa', downloadUrl: 'https://builder.example/ipa', expiresAt, fileName: 'app.ipa' }
  const apk = { kind: 'android_apk', downloadUrl: 'https://builder.example/apk', expiresAt, fileName: 'app.apk' }

  it('keeps the iOS package for an iOS build', () => {
    expect(pickSavedOutput([apk, ipa], 'ios')).toMatchObject({ url: ipa.downloadUrl, kind: 'ios_ipa', expires_at: '2099-01-01T00:00:00.000Z' })
  })

  it('keeps the Android package for an Android build', () => {
    expect(pickSavedOutput([ipa, apk], 'android')).toMatchObject({ url: apk.downloadUrl, kind: 'android_apk', expires_at: '2099-01-01T00:00:00.000Z' })
  })

  it('drops a package whose download has expired', () => {
    expect(pickSavedOutput([{ ...ipa, expiresAt: Date.parse('2020-01-01T00:00:00.000Z') }], 'ios')).toBeUndefined()
  })

  it('ignores a link that is not https', () => {
    expect(pickSavedOutput([{ ...ipa, downloadUrl: 'http://builder.example/ipa' }], 'ios')).toBeUndefined()
  })

  it('reports the jobs whose builder lookup failed, but not a job the builder no longer knows', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/job_ok'))
        return new Response(JSON.stringify({ outputs: [ipa] }), { status: 200 })
      if (url.endsWith('/job_gone'))
        return new Response(null, { status: 404 })
      if (url.endsWith('/job_down'))
        return new Response(null, { status: 503 })
      throw new Error('timeout')
    }))
    const failed: string[] = []
    const outputs = await savedOutputsForJobs({} as never, {} as never, 'app', 'org', ['job_ok', 'job_gone', 'job_down', 'job_slow'], failed)
    vi.unstubAllGlobals()
    expect(Object.keys(outputs)).toEqual(['job_ok'])
    expect(failed.sort()).toEqual(['job_down', 'job_slow'])
  })
})
