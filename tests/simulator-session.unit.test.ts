import { describe, expect, it } from 'vitest'
import { canFinishSimulatorStop, emulatorSessionCreateBody, isSimulatorSessionId, multipartIpaStream, SAVED_IPA_MAX_BYTES, savedIpaContentLength, simulatorBillableSeconds, simulatorBillingInstant, simulatorCreateWasInterrupted, simulatorHostStopIsFinal, simulatorRequestFields, simulatorUsageEnd, startupFailureKeepsSlot } from '../supabase/functions/_backend/public/build/simulator.ts'

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
    expect(simulatorBillableSeconds('2026-10-29T12:00:00.000Z', Date.parse('2026-10-29T14:00:00.000Z'), 40)).toBe(2400)
    const stoppedAt = '2026-10-29T12:05:00.000Z'
    const retryAt = Date.parse('2026-10-29T12:15:00.000Z')
    expect(simulatorUsageEnd(stoppedAt, retryAt)).toBe(Date.parse(stoppedAt))
    expect(simulatorBillableSeconds('2026-10-29T12:00:00.000Z', simulatorUsageEnd(stoppedAt, retryAt), 40)).toBe(300)
    const nextDay = Date.parse('2026-10-30T08:00:00.000Z')
    expect(simulatorBillingInstant('2026-10-29T23:50:00.000Z', nextDay, 40)).toBe(Date.parse('2026-10-30T00:30:00.000Z'))
  })

  it('rejects a request that is not the simulator contract', () => {
    expect(simulatorRequestFields({ app_id: ' ee.forgr.capgo ', platform: 'android', name: ' Checkout ' })).toEqual({
      appId: 'ee.forgr.capgo',
      platform: 'android',
      name: 'Checkout',
    })
    expect(simulatorRequestFields({ app_id: 'ee.forgr.capgo', platform: 'ios', name: null })).toMatchObject({ name: undefined })
    expect(() => simulatorRequestFields({ app_id: 12, platform: 'ios' })).toThrow()
    expect(() => simulatorRequestFields({ app_id: 'ee.forgr.capgo', platform: 'ios', name: 12 })).toThrow()
    expect(isSimulatorSessionId('6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4')).toBe(true)
    expect(isSimulatorSessionId('session-1')).toBe(false)
  })

  it('keeps the slot when the device or the billing write is not finished', () => {
    expect(simulatorHostStopIsFinal(404)).toBe(true)
    expect(simulatorHostStopIsFinal(500)).toBe(false)
    expect(canFinishSimulatorStop({ remoteStatus: 500, billingRecorded: true, seconds: 30 })).toBe(false)
    expect(canFinishSimulatorStop({ remoteStatus: 404, billingRecorded: false, seconds: 30 })).toBe(false)
    expect(canFinishSimulatorStop({ remoteStatus: 200, billingRecorded: true, seconds: 30 })).toBe(true)
    expect(canFinishSimulatorStop({ remoteStatus: null, billingRecorded: true, seconds: 0 })).toBe(true)
    expect(startupFailureKeepsSlot('device-1', false)).toBe(true)
    expect(startupFailureKeepsSlot('device-1', true)).toBe(false)
    expect(startupFailureKeepsSlot('', false)).toBe(false)
    expect(simulatorCreateWasInterrupted(new Error('The operation was aborted.'))).toBe(true)
    expect(simulatorCreateWasInterrupted(new Error('Simulator did not return a session URL.'))).toBe(false)
    expect(emulatorSessionCreateBody({
      id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4',
      appId: 'ee.forgr.capgo',
      platform: 'ios',
      orgId: '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57',
    }).id).toBe('6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4')
  })

  it('streams a saved IPA and stops when the declared size is past the device limit', async () => {
    expect(savedIpaContentLength(null)).toBeUndefined()
    expect(savedIpaContentLength(String(SAVED_IPA_MAX_BYTES))).toBe(SAVED_IPA_MAX_BYTES)
    expect(savedIpaContentLength(String(SAVED_IPA_MAX_BYTES + 1))).toBeGreaterThan(SAVED_IPA_MAX_BYTES)
    const text = new TextDecoder().decode(await new Response(multipartIpaStream(new Blob(['ipa']).stream(), 'bound')).arrayBuffer())
    expect(text.startsWith('--bound\r\nContent-Disposition: form-data; name="ipa"; filename="app.ipa"\r\n')).toBe(true)
    expect(text.endsWith('ipa\r\n--bound--\r\n')).toBe(true)
    await expect(new Response(multipartIpaStream(new Blob([new Uint8Array(8)]).stream(), 'bound', 4)).arrayBuffer()).rejects.toThrow('too large')
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3))
        controller.enqueue(new Uint8Array(3))
        controller.close()
      },
    })
    await expect(new Response(multipartIpaStream(chunks, 'bound', 4)).arrayBuffer()).rejects.toThrow('too large')
  })
})
