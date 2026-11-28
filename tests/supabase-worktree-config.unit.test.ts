import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocalDbConfig } from '../scripts/local-db'
import { getSupabaseWorktreeConfig } from '../scripts/supabase-worktree-config'

describe('SUPABASE_WORKTREE_PORT_BASE', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('moves every stack port, keeping the offset band', () => {
    vi.stubEnv('SUPABASE_WORKTREE_PORT_OFFSET', '6100')
    vi.stubEnv('SUPABASE_WORKTREE_PORT_BASE', '')
    const standard = getSupabaseWorktreeConfig().ports
    vi.stubEnv('SUPABASE_WORKTREE_PORT_BASE', '20321')
    const shifted = getSupabaseWorktreeConfig().ports

    expect(shifted.api).toBe(26421)
    expect(shifted.db - shifted.api).toBe(standard.db - standard.api)
    expect(shifted.edgeInspector).toBe(standard.edgeInspector)
    expect(getLocalDbConfig().port).toBe(shifted.db + 6)
  })

  it('keeps the CI base, with the largest CI and hash offsets, below the ephemeral range', () => {
    vi.stubEnv('SUPABASE_WORKTREE_PORT_BASE', '20321')
    for (const offset of ['6100', '9990']) {
      vi.stubEnv('SUPABASE_WORKTREE_PORT_OFFSET', offset)
      for (const port of Object.values(getSupabaseWorktreeConfig().ports))
        expect(port).toBeLessThan(32768)
    }
  })

  it('rejects a base that leaves no room for the offsets', () => {
    vi.stubEnv('SUPABASE_WORKTREE_PORT_BASE', '60000')
    expect(() => getSupabaseWorktreeConfig()).toThrow('SUPABASE_WORKTREE_PORT_BASE')
    vi.stubEnv('SUPABASE_WORKTREE_PORT_BASE', 'abc')
    expect(() => getSupabaseWorktreeConfig()).toThrow('SUPABASE_WORKTREE_PORT_BASE')
  })
})
