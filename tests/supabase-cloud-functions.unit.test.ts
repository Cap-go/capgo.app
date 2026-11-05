import { describe, expect, it } from 'vitest'
import {
  buildCapgoCloudSupabaseDeployArgs,
  CAPGO_CLOUD_SUPABASE_FUNCTIONS,
  listCapgoCloudSkippedSupabaseFunctions,
  listLocalSupabaseFunctions,
} from '../scripts/supabase-cloud-functions'

describe('supabase cloud function allowlist', () => {
  it.concurrent('deploys pg_net triggers plus the CLI-deprecated functions by default', () => {
    expect(buildCapgoCloudSupabaseDeployArgs()).toEqual(['triggers', 'bundle', 'channel', 'files', 'private'])
  })

  it.concurrent('no longer publishes console-only invoke targets on Capgo cloud Supabase', () => {
    for (const name of ['apikey', 'app', 'organization', 'statistics', 'webhooks'] as const) {
      expect(CAPGO_CLOUD_SUPABASE_FUNCTIONS).not.toContain(name)
      expect(listCapgoCloudSkippedSupabaseFunctions()).toContain(name)
    }
  })

  it.concurrent('builds deploy args from an explicit list', () => {
    expect(buildCapgoCloudSupabaseDeployArgs(['triggers', 'ok'])).toEqual(['triggers', 'ok'])
  })

  it.concurrent('rejects an empty Capgo cloud deploy selection', () => {
    expect(() => buildCapgoCloudSupabaseDeployArgs([])).toThrow('CAPGO_CLOUD_SUPABASE_FUNCTIONS must not be empty')
  })

  it.concurrent('skips Capgo-cloud-only unused local functions while keeping allowlisted ones', () => {
    const local = listLocalSupabaseFunctions()
    expect(local).toContain('triggers')
    expect(local).toContain('private')
    expect(local).toContain('updates')

    const skipped = listCapgoCloudSkippedSupabaseFunctions(local)
    for (const keep of CAPGO_CLOUD_SUPABASE_FUNCTIONS)
      expect(skipped).not.toContain(keep)
    expect(skipped).toContain('updates')
    expect(skipped).toContain('stats')
    expect(skipped).toContain('ok')
    expect(skipped.length).toBe(local.length - CAPGO_CLOUD_SUPABASE_FUNCTIONS.length)
  })
})
