import { describe, expect, it } from 'vitest'
import {
  channelHasProgressiveRollout,
  resolveSetChannelTarget,
} from '../supabase/functions/_backend/public/bundle/set_channel.ts'

describe('bundle set channel rollout targeting', () => {
  it('detects progressive rollout configuration', () => {
    expect(channelHasProgressiveRollout({ rollout_enabled: false, rollout_version: null })).toBe(false)
    expect(channelHasProgressiveRollout({ rollout_enabled: true, rollout_version: null })).toBe(true)
    expect(channelHasProgressiveRollout({ rollout_enabled: false, rollout_version: 12 })).toBe(true)
  })

  it('defaults to rollout when progressive rollout is configured', () => {
    expect(resolveSetChannelTarget({ rollout_enabled: true, rollout_version: 12 }, 'auto')).toBe('rollout')
    expect(resolveSetChannelTarget({ rollout_enabled: false, rollout_version: null }, 'auto')).toBe('stable')
  })

  it('honors explicit stable and rollout targets', () => {
    expect(resolveSetChannelTarget({ rollout_enabled: true, rollout_version: 12 }, 'stable')).toBe('stable')
    expect(resolveSetChannelTarget({ rollout_enabled: false, rollout_version: null }, 'rollout')).toBe('rollout')
  })
})
