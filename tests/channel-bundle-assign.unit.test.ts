import { describe, expect, it } from 'vitest'
import { buildChannelBundleAssignUpdate, resolveChannelBundleAssignTarget } from '../src/services/channelBundleAssign.ts'

describe('channel bundle assign helpers', () => {
  it('defaults to rollout when progressive rollout is configured', () => {
    expect(resolveChannelBundleAssignTarget({
      rollout_enabled: true,
      rollout_version: 10,
      version: 5,
    }, 'auto')).toBe('rollout')
  })

  it('builds rollout updates without touching stable', () => {
    expect(buildChannelBundleAssignUpdate({
      rollout_enabled: true,
      rollout_version: 10,
      version: 5,
    }, 99, 'auto')).toEqual({
      rollout_version: 99,
      rollout_enabled: true,
    })
  })

  it('builds stable updates when requested', () => {
    expect(buildChannelBundleAssignUpdate({
      rollout_enabled: true,
      rollout_version: 10,
      version: 5,
    }, 99, 'stable')).toEqual({
      version: 99,
    })
  })
})
