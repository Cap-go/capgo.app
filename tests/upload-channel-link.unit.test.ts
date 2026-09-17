import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  formatClearedProgressiveRolloutSuccess,
  formatStableChannelLinkSuccess,
  hasActiveRollout,
  shouldFailOnActiveRollout,
} from '../cli/src/bundle/upload-channel-link'

describe('bundle upload channel-link helpers', () => {
  it('detects active progressive rollout state', () => {
    expect(hasActiveRollout({ rollout_enabled: true, rollout_version: 10 })).toBe(true)
    expect(hasActiveRollout({ rollout_enabled: false, rollout_version: 10 })).toBe(false)
  })

  it('blocks stable uploads only when fail-on-active-rollout is set', () => {
    expect(shouldFailOnActiveRollout(
      { failOnActiveRollout: true },
      { rollout_enabled: true, rollout_version: 10 },
    )).toBe(true)
    expect(shouldFailOnActiveRollout(
      { failOnActiveRollout: true, rolloutAdvance: true },
      { rollout_enabled: true, rollout_version: 10 },
    )).toBe(false)
  })

  it('formats stable link success for CI logs', () => {
    expect(formatStableChannelLinkSuccess('production', '1.0.0'))
      .toBe('Linked @1.0.0 to channel production as stable.')
    expect(formatClearedProgressiveRolloutSuccess('production'))
      .toBe('Cleared progressive rollout on production.')
  })
})

describe('bundle upload rollout messaging source', () => {
  it('does not claim final success before channel assignment during zip upload', () => {
    const source = readFileSync(new URL('../cli/src/bundle/upload.ts', import.meta.url), 'utf8')
    expect(source).toContain('Bundle zip uploaded in')
    expect(source).not.toContain('Bundle uploaded 💪')
  })

  it('checks fail-on-active-rollout during channel preflight', () => {
    const source = readFileSync(new URL('../cli/src/bundle/upload.ts', import.meta.url), 'utf8')
    expect(source).toContain('shouldFailOnActiveRollout(options, targetChannel)')
  })

  it('always prints link-device guidance after stable assignment', () => {
    const source = readFileSync(new URL('../cli/src/bundle/upload.ts', import.meta.url), 'utf8')
    expect(source).toContain('Link device to this bundle to try it:')
    expect(source).not.toMatch(/else if \(!clearedActiveRollout\)/)
  })
})
