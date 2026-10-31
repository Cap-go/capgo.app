import { describe, expect, it } from 'bun:test'
import { simulatorApiRequest, simulatorTextOutput } from '../src/simulator/session'

describe('simulator CLI requests', () => {
  it('starts, reads, and stops one session', () => {
    expect(simulatorApiRequest('https://api.capgo.app/', 'start', {
      appId: 'ee.forgr.capgo',
      platform: 'ios',
      name: 'Checkout',
    })).toEqual({
      method: 'POST',
      url: 'https://api.capgo.app/build/simulator',
      body: { app_id: 'ee.forgr.capgo', platform: 'ios', name: 'Checkout' },
    })
    expect(simulatorApiRequest('https://api.capgo.app', 'get', {
      appId: 'ee.forgr.capgo',
      id: 'session-1',
    }).url).toBe('https://api.capgo.app/build/simulator/session-1?app_id=ee.forgr.capgo')
    expect(simulatorApiRequest('https://api.capgo.app', 'stop', {
      appId: 'ee.forgr.capgo',
      id: 'session-1',
    })).toEqual({
      method: 'POST',
      url: 'https://api.capgo.app/build/simulator/session-1/stop',
      body: { app_id: 'ee.forgr.capgo' },
    })
  })

  it('prints the session id before the URL', () => {
    expect(simulatorTextOutput({
      id: 'session-1',
      url: 'https://ios-emulator.capgo.app/s/session-1/',
    })).toBe('session-1\nhttps://ios-emulator.capgo.app/s/session-1/\n')
    expect(simulatorTextOutput({ status: 'stopped' })).toBe('stopped\n')
  })
})
