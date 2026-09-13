import { describe, expect, it } from 'vitest'
import {
  buildChannelBundleAssignUpdate,
  buildChannelBundleUnlinkUpdate,
  isBundleLinkedToChannel,
  resolveChannelBundleAssignTarget,
} from '../src/services/channelBundleAssign.ts'

describe('channel bundle assign helpers', () => {
  it('defaults to rollout when progressive rollout is configured', () => {
    expect(resolveChannelBundleAssignTarget({
      rollout_enabled: true,
      rollout_version: 10,
      version: 5,
    }, 'auto')).toBe('rollout')
  })

  it('builds rollout updates without touching stable or rollout_enabled', () => {
    expect(buildChannelBundleAssignUpdate({
      rollout_enabled: true,
      rollout_version: 10,
      version: 5,
    }, 99, 'auto')).toEqual({
      rollout_version: 99,
    })
    expect(buildChannelBundleAssignUpdate({
      rollout_enabled: false,
      rollout_version: 10,
      version: 5,
    }, 99, 'rollout')).toEqual({
      rollout_version: 99,
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

  it('detects stable and rollout bundle associations', () => {
    expect(isBundleLinkedToChannel({ version: 5, rollout_version: null }, 5)).toBe(true)
    expect(isBundleLinkedToChannel({ version: 5, rollout_version: 10 }, 10)).toBe(true)
    expect(isBundleLinkedToChannel({ version: 5, rollout_version: 10 }, 99)).toBe(false)
  })

  it('unlinks the matching stable or rollout field', () => {
    expect(buildChannelBundleUnlinkUpdate({ version: 5, rollout_version: 10 }, 10)).toEqual({
      rollout_version: null,
    })
    expect(buildChannelBundleUnlinkUpdate({ version: 5, rollout_version: 10 }, 5)).toEqual({
      version: null,
    })
    expect(buildChannelBundleUnlinkUpdate({ version: 5, rollout_version: 10 }, 99)).toBeNull()
  })
})
