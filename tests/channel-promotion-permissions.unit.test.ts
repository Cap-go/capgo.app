import { describe, expect, it } from 'vitest'
import { findChannelsWithoutPromotionPermission, formatChannelPromotionTargets } from '../src/services/channelPromotion'

describe('channel promotion permission helpers', () => {
  it('returns channels without promote permission', async () => {
    const batches: number[] = []
    const deniedChannels = await findChannelsWithoutPromotionPermission('com.test.app', [
      { id: 10, name: 'Production' },
      { id: 20, name: 'Staging' },
    ], async (requests) => {
      batches.push(requests.length)
      return requests.map(request => request.permissions === 'channel.promote_bundle' && request.scope.channelId === 20)
    })

    expect(deniedChannels).toEqual([{ id: 10, name: 'Production' }])
    // Every channel is checked in a single batch.
    expect(batches).toEqual([2])
  })

  it('fails closed when the batched permission check rejects', async () => {
    const deniedChannels = await findChannelsWithoutPromotionPermission('com.test.app', [
      { id: 10, name: 'Production' },
      { id: 20, name: 'Staging' },
    ], async () => {
      throw new Error('permission check failed')
    })

    expect(deniedChannels).toEqual([{ id: 10, name: 'Production' }, { id: 20, name: 'Staging' }])
  })

  it('treats missing results as denied', async () => {
    const deniedChannels = await findChannelsWithoutPromotionPermission('com.test.app', [
      { id: 10, name: 'Production' },
      { id: 20, name: 'Staging' },
    ], async () => [true])

    expect(deniedChannels).toEqual([{ id: 20, name: 'Staging' }])
  })

  it('formats denied channel names for deletion blockers', () => {
    expect(formatChannelPromotionTargets([
      { id: 10, name: 'Production' },
      { id: 20, name: 'Staging' },
    ])).toBe('Production, Staging')
  })
})
