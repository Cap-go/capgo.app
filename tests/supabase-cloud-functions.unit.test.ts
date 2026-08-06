import { describe, expect, it } from 'vitest'
import {
  buildCapgoCloudSupabaseDeployArgs,
  CAPGO_CLOUD_SUPABASE_FUNCTIONS,
  CAPGO_CLOUD_SUPABASE_FUNCTIONS_CLI_DEPRECATION,
  CAPGO_CLOUD_SUPABASE_FUNCTIONS_CLI_DEPRECATION_UNTIL,
  CAPGO_CLOUD_SUPABASE_FUNCTIONS_FOREVER,
  listCapgoCloudSkippedSupabaseFunctions,
  listLocalSupabaseFunctions,
} from '../scripts/supabase-cloud-functions'

describe('supabase cloud function allowlist', () => {
  it.concurrent('keeps pg_net triggers forever and CLI-deprecated functions until sunset', () => {
    expect([...CAPGO_CLOUD_SUPABASE_FUNCTIONS_FOREVER]).toEqual(['triggers'])
    expect([...CAPGO_CLOUD_SUPABASE_FUNCTIONS_CLI_DEPRECATION]).toEqual([
      'bundle',
      'channel',
      'files',
      'private',
    ])
    expect(CAPGO_CLOUD_SUPABASE_FUNCTIONS_CLI_DEPRECATION_UNTIL).toBe('2026-10-28')
    expect([...CAPGO_CLOUD_SUPABASE_FUNCTIONS]).toEqual([
      'triggers',
      'bundle',
      'channel',
      'files',
      'private',
    ])
    expect(buildCapgoCloudSupabaseDeployArgs()).toEqual([...CAPGO_CLOUD_SUPABASE_FUNCTIONS])
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
