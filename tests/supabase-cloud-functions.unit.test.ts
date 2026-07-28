import { describe, expect, it } from 'vitest'
import {
  buildCapgoCloudSupabaseDeployArgs,
  CAPGO_CLOUD_SUPABASE_FUNCTIONS,
  listCapgoCloudSkippedSupabaseFunctions,
  listLocalSupabaseFunctions,
} from '../scripts/supabase-cloud-functions.ts'

describe('supabase cloud function allowlist', () => {
  it('keeps SDK invoke + pg_net Capgo cloud functions', () => {
    expect([...CAPGO_CLOUD_SUPABASE_FUNCTIONS]).toEqual([
      'apikey',
      'app',
      'bundle',
      'channel',
      'files',
      'organization',
      'private',
      'statistics',
      'triggers',
      'webhooks',
    ])
    expect(buildCapgoCloudSupabaseDeployArgs()).toEqual([...CAPGO_CLOUD_SUPABASE_FUNCTIONS])
  })

  it('rejects an empty explicit deploy list', () => {
    expect(() => buildCapgoCloudSupabaseDeployArgs([])).toThrow(/must not be empty/)
  })

  it('passes through multiple explicit deploy targets', () => {
    expect(buildCapgoCloudSupabaseDeployArgs(['triggers', 'ok'])).toEqual(['triggers', 'ok'])
  })

  it('skips plugin/ops functions not used via supabase.functions.invoke', () => {
    const local = listLocalSupabaseFunctions()
    expect(local).toContain('triggers')
    expect(local).toContain('private')
    expect(local).toContain('updates')
    expect(local).toContain('stats')

    const skipped = listCapgoCloudSkippedSupabaseFunctions(local)
    for (const keep of CAPGO_CLOUD_SUPABASE_FUNCTIONS)
      expect(skipped).not.toContain(keep)

    expect(skipped).toContain('updates')
    expect(skipped).toContain('stats')
    expect(skipped).toContain('channel_self')
    expect(skipped).toContain('updates_debug')
    expect(skipped).toContain('device')
    expect(skipped).toContain('build')
    expect(skipped).toContain('ok')
    expect(skipped).toContain('queue_health')
    expect(skipped.length).toBe(local.length - CAPGO_CLOUD_SUPABASE_FUNCTIONS.length)
  })
})
