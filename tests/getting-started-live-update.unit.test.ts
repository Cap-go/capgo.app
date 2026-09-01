import { describe, expect, it } from 'vitest'
import {
  isLiveUpdateGuide,
  liveUpdateChannelPath,
  liveUpdateUploadPath,
  pickProductionChannel,
} from '../src/utils/gettingStartedLiveUpdate.ts'

describe('getting started live update routing', () => {
  it.concurrent('prefers the public production channel, then a production-named channel', () => {
    expect(pickProductionChannel([
      { id: 2, name: 'dev', public: false },
      { id: 9, name: 'staging', public: true },
      { id: 4, name: 'production', public: false },
    ])).toEqual({ id: 9, name: 'staging', public: true })
    expect(pickProductionChannel([
      { id: 2, name: 'dev', public: false },
      { id: 4, name: 'production', public: false },
    ])).toEqual({ id: 4, name: 'production', public: false })
    expect(pickProductionChannel([
      { id: 2, name: 'dev', public: false },
      { id: 7, name: 'Production', public: false },
    ])).toEqual({ id: 7, name: 'Production', public: false })
    expect(pickProductionChannel([{ id: 2, name: 'dev', public: false }])).toBeNull()
  })

  it.concurrent('sends uploads through the live-update guide and then the channel page', () => {
    expect(isLiveUpdateGuide('live-update')).toBe(true)
    expect(isLiveUpdateGuide('bundles')).toBe(false)
    expect(liveUpdateUploadPath('com.demo.app')).toBe('/app/com.demo.app/bundles/new?guide=live-update')
    expect(liveUpdateChannelPath('com.demo.app', 12)).toBe('/app/com.demo.app/channel/12')
    expect(liveUpdateChannelPath('com.demo.app', null)).toBe('/app/com.demo.app/channels')
  })
})
