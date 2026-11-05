import { describe, expect, it } from 'vitest'
import { findChannelsWithoutPromotionPermission, formatChannelPromotionTargets } from '../src/services/channelPromotion'

describe('channel promotion permission helpers', () => {
  it('returns channels without promote permission', async () => {
    const deniedChannels = await findChannelsWithoutPromotionPermission('com.test.app', [
      { id: 10, name: 'Production' },
      { id: 20, name: 'Staging' },
    ], async (_permission, scope) => scope.channelId === 20)

    expect(deniedChannels).toEqual([{ id: 10, name: 'Production' }])
  })

  it('fails closed when a channel permission check rejects', async () => {
    const deniedChannels = await findChannelsWithoutPromotionPermission('com.test.app', [
      { id: 10, name: 'Production' },
      { id: 20, name: 'Staging' },
    ], async (_permission, scope) => {
      if (scope.channelId === 10)
        throw new Error('permission check failed')
      return true
    })

    expect(deniedChannels).toEqual([{ id: 10, name: 'Production' }])
  })

  it('formats denied channel names for deletion blockers', () => {
    expect(formatChannelPromotionTargets([
      { id: 10, name: 'Production' },
      { id: 20, name: 'Staging' },
    ])).toBe('Production, Staging')
  })
})
