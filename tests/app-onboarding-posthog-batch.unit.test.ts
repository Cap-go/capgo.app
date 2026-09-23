import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackPosthogEventBatch } from '../supabase/functions/_backend/utils/posthog.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('queued onboarding telemetry', () => {
  it('sends many step events with one request and app-scoped identities', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('POSTHOG_API_KEY', 'test-project-key')
    vi.stubEnv('POSTHOG_API_HOST', 'https://eu.i.posthog.com/capture/')
    const c = {
      get: () => 'request-id',
    } as any
    const payloads = [
      { channel: 'app-onboarding', event: 'App Onboarding Step Changed', distinct_id: 'app-onboarding-app:app-a', setPersonProperties: false, nonPersonTags: { step_id: 'run_device', $insert_id: 'step-1' } },
      { channel: 'app-onboarding', event: 'App Onboarding Step Changed', distinct_id: 'app-onboarding-app:app-b', setPersonProperties: false, nonPersonTags: { step_id: 'test_update', $insert_id: 'step-2' } },
    ]
    expect(await trackPosthogEventBatch(c, payloads)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as any
    expect(url).toBe('https://eu.i.posthog.com/batch/')
    const body = JSON.parse(options.body)
    expect(body.api_key).toBe('test-project-key')
    expect(body.batch).toHaveLength(2)
    expect(body.batch[0]).toMatchObject({ properties: { distinct_id: 'app-onboarding-app:app-a', step_id: 'run_device', $insert_id: 'step-1' } })
    expect(body.batch[0].properties.$set).toBeUndefined()
  })
})
