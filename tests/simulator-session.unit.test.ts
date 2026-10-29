import { describe, expect, it } from 'vitest'
import { canFinishSimulatorStop, emulatorSessionCreateBody, simulatorBillableSeconds, simulatorHostStopIsFinal } from '../supabase/functions/_backend/public/build/simulator.ts'

describe('simulator sessions', () => {
  it('asks the device host for one session tied to the Capgo org', () => {
    expect(emulatorSessionCreateBody({
      appId: 'ee.forgr.capgo',
      platform: 'android',
      orgId: '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57',
      name: 'Checkout',
    })).toEqual({
      appId: 'ee.forgr.capgo',
      platform: 'android',
      orgId: '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57',
      name: 'Checkout',
      type: 'agent-device',
      maxDurationMinutes: 40,
    })
  })

  it('bills the seconds the simulator stayed open', () => {
    expect(simulatorBillableSeconds('2026-10-29T12:00:00.000Z', Date.parse('2026-10-29T12:00:30.400Z'))).toBe(30)
    expect(simulatorBillableSeconds(null)).toBe(0)
    expect(simulatorBillableSeconds('2026-10-29T12:00:00.400Z', Date.parse('2026-10-29T12:00:00.600Z'))).toBe(1)
  })

  it('keeps the slot when the device or the billing write is not finished', () => {
    expect(simulatorHostStopIsFinal(404)).toBe(true)
    expect(simulatorHostStopIsFinal(500)).toBe(false)
    expect(canFinishSimulatorStop({ remoteStatus: 500, billingRecorded: true, seconds: 30 })).toBe(false)
    expect(canFinishSimulatorStop({ remoteStatus: 404, billingRecorded: false, seconds: 30 })).toBe(false)
    expect(canFinishSimulatorStop({ remoteStatus: 200, billingRecorded: true, seconds: 30 })).toBe(true)
    expect(canFinishSimulatorStop({ remoteStatus: null, billingRecorded: true, seconds: 0 })).toBe(true)
  })
})
