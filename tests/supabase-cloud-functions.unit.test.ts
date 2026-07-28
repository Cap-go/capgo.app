import { describe, expect, it } from 'vitest'
import {
  buildCapgoCloudSupabaseDeployArgs,
  CAPGO_CLOUD_SUPABASE_FUNCTIONS,
  listCapgoCloudSkippedSupabaseFunctions,
  listLocalSupabaseFunctions,
} from '../scripts/supabase-cloud-functions.ts'

describe('supabase cloud function allowlist', () => {
  it('keeps only triggers for Capgo cloud deploys', () => {
    expect([...CAPGO_CLOUD_SUPABASE_FUNCTIONS]).toEqual(['triggers'])
    expect(buildCapgoCloudSupabaseDeployArgs()).toEqual(['triggers'])
  })

  it('rejects an empty explicit deploy list', () => {
    expect(() => buildCapgoCloudSupabaseDeployArgs([])).toThrow(/must not be empty/)
  })

  it('passes through multiple explicit deploy targets', () => {
    expect(buildCapgoCloudSupabaseDeployArgs(['triggers', 'ok'])).toEqual(['triggers', 'ok'])
  })

  it('skips every local function except the Capgo cloud allowlist', () => {
    const local = listLocalSupabaseFunctions()
    expect(local).toContain('triggers')
    expect(local).toContain('updates')
    expect(local).toContain('stats')
    expect(local).toContain('private')

    const skipped = listCapgoCloudSkippedSupabaseFunctions(local)
    expect(skipped).not.toContain('triggers')
    expect(skipped).toContain('updates')
    expect(skipped).toContain('stats')
    expect(skipped).toContain('channel_self')
    expect(skipped).toContain('private')
    expect(skipped).toContain('files')
    expect(skipped.length).toBe(local.length - CAPGO_CLOUD_SUPABASE_FUNCTIONS.length)
  })
})
