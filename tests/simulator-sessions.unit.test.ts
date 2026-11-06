import { describe, expect, it } from 'vitest'
import { forgetSimulator, rememberSimulator, runningSimulators } from '../src/services/simulatorSessions'

describe('running simulator sessions', () => {
  it('keeps a session started outside the card so it can be stopped', () => {
    const appId = 'ee.forgr.saved-build'
    rememberSimulator(appId, { id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4', url: 'https://ios-emulator.capgo.app/s/6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4/' })
    rememberSimulator(appId, { id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4', url: 'https://ios-emulator.capgo.app/s/6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4/' })
    expect(runningSimulators(appId)).toHaveLength(1)
    forgetSimulator(appId, '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4')
    expect(runningSimulators(appId)).toHaveLength(0)
  })
})
