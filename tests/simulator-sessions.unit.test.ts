import { describe, expect, it } from 'vitest'
import { clearSimulatorSessions, forgetSimulator, rememberSimulator, runningSimulators, sessionRemainsAfterLookup, simulatorEpoch } from '../src/services/simulatorSessions'

describe('running simulator sessions', () => {
  it('keeps a session started outside the card so it can be stopped', () => {
    const appId = 'ee.forgr.saved-build'
    rememberSimulator(appId, { id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4', url: 'https://ios-emulator.capgo.app/s/6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4/' })
    rememberSimulator(appId, { id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4', url: 'https://ios-emulator.capgo.app/s/6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4/' })
    expect(runningSimulators(appId)).toHaveLength(1)
    forgetSimulator(appId, '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4')
    expect(runningSimulators(appId)).toHaveLength(0)
  })

  it('keeps each app session separate and drops them all on sign-out', () => {
    rememberSimulator('app-a', { id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4', url: 'https://ios-emulator.capgo.app/s/a/' })
    rememberSimulator('app-b', { id: '7b1e0d3f-2c50-4f9b-8d44-1c8f6e3b22d5', url: 'https://ios-emulator.capgo.app/s/b/' })
    expect(runningSimulators('app-a')).toHaveLength(1)
    expect(runningSimulators('app-b')).toHaveLength(1)
    forgetSimulator('app-a', '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4')
    expect(runningSimulators('app-a')).toHaveLength(0)
    expect(runningSimulators('app-b')).toHaveLength(1)
    clearSimulatorSessions()
    expect(runningSimulators('app-b')).toHaveLength(0)
  })

  it('drops a start that finishes after sign-out', () => {
    const epoch = simulatorEpoch()
    clearSimulatorSessions()
    rememberSimulator('app-a', { id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4', url: 'https://ios-emulator.capgo.app/s/a/' }, epoch)
    expect(runningSimulators('app-a')).toHaveLength(0)
  })

  it('drops a remembered session that is gone and keeps one whose lookup fails', async () => {
    const appId = 'app-refresh'
    const id = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
    const session = { id, url: 'https://ios-emulator.capgo.app/s/a/' }
    rememberSimulator(appId, session)
    if (!await sessionRemainsAfterLookup(async () => ({ httpStatus: 400 })))
      forgetSimulator(appId, id)
    expect(runningSimulators(appId)).toHaveLength(0)
    rememberSimulator(appId, session)
    if (!await sessionRemainsAfterLookup(async () => ({ httpStatus: 404 })))
      forgetSimulator(appId, id)
    expect(runningSimulators(appId)).toHaveLength(0)
    rememberSimulator(appId, session)
    if (!await sessionRemainsAfterLookup(async () => ({ httpStatus: 200, sessionStatus: 'stopped' })))
      forgetSimulator(appId, id)
    expect(runningSimulators(appId)).toHaveLength(0)
    rememberSimulator(appId, session)
    const failed = await sessionRemainsAfterLookup(async () => {
      throw new Error('offline')
    })
    expect(failed).toBe(true)
    expect(runningSimulators(appId)).toHaveLength(1)
    forgetSimulator(appId, id)
  })
})
