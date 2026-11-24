import { describe, expect, it } from 'vitest'
import { canFinishSimulatorStop, emulatorSessionCreateBody, isSimulatorSessionId, ipaUploadStream, readCappedBytes, SAVED_IPA_MAX_BYTES, savedIpaContentLength, SIMULATOR_STOPPED_MESSAGE, simulatorArtifactUrl, simulatorBillableSeconds, simulatorBillingInstant, simulatorCommandRpc, simulatorCreateWasInterrupted, simulatorDeviceUrl, simulatorHostStopIsFinal, simulatorListItem, simulatorRequestFields, simulatorUsageEnd, startupFailureKeepsSlot } from '../supabase/functions/_backend/public/build/simulator.ts'
import { deviceStopTime } from '../supabase/functions/_backend/public/build/simulator_host.ts'

describe('simulator sessions', () => {
  it('downloads saved IPA tokens from the builder origin and preserves other artifact URLs', () => {
    const builder = 'https://builder.example.com'
    expect(simulatorArtifactUrl('https://api.example.com/builder_download_direct_artefact/test-token', builder))
      .toBe('https://builder.example.com/builder_download_direct_artefact/test-token?target=simulator')
    const external = 'https://storage.example.com/archive.ipa?signature=test'
    expect(simulatorArtifactUrl(external, builder)).toBe(external)
  })

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
      maxIdleTimeMinutes: 5,
    })
  })

  it('bills a device the host stopped for lack of input up to that stop', () => {
    const now = Date.parse('2026-11-09T12:30:00.000Z')
    expect(deviceStopTime({ id: 'a', url: 'u', status: 'in-progress', finishedAt: null }, now)).toBeUndefined()
    expect(deviceStopTime(undefined, now)).toBeUndefined()
    const stoppedAt = deviceStopTime({ id: 'a', url: 'u', status: 'stopped', finishedAt: '2026-11-09T12:07:00.000Z' }, now)
    expect(stoppedAt).toBe('2026-11-09T12:07:00.000Z')
    // Seven minutes, not the 40 minute maximum.
    expect(simulatorBillableSeconds('2026-11-09T12:00:00.000Z', simulatorUsageEnd(stoppedAt ?? null, now))).toBe(420)
    // A host clock ahead of ours never bills past now.
    expect(deviceStopTime({ id: 'a', url: 'u', status: 'stopped', finishedAt: '2026-11-09T13:00:00.000Z' }, now)).toBe('2026-11-09T12:30:00.000Z')
    expect(deviceStopTime({ id: 'a', url: 'u', status: 'errored' }, now)).toBe('2026-11-09T12:30:00.000Z')
    expect(SIMULATOR_STOPPED_MESSAGE).toContain('5 minutes without input')
  })

  it('lists a session with the build time it counted', () => {
    expect(simulatorListItem({
      id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4',
      platform: 'ios',
      status: 'stopped',
      url: 'https://ios-emulator.capgo.app/s/6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4/',
      started_at: '2026-11-09T12:00:00.000Z',
      finished_at: '2026-11-09T12:07:00.000Z',
      build_time_unit: '420',
      billable_seconds: '840',
    })).toEqual({
      id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4',
      platform: 'ios',
      status: 'stopped',
      url: null,
      started_at: '2026-11-09T12:00:00.000Z',
      finished_at: '2026-11-09T12:07:00.000Z',
      build_time_seconds: 420,
      billable_seconds: 840,
    })
    expect(simulatorListItem({
      id: '7b1e0d3f-2c50-4f9b-8d44-1c8f6e3b22d5',
      platform: 'android',
      status: 'in-progress',
      url: 'https://ios-emulator.capgo.app/s/7b1e0d3f-2c50-4f9b-8d44-1c8f6e3b22d5/',
      started_at: '2026-11-09T12:00:00.000Z',
      finished_at: null,
      build_time_unit: null,
      billable_seconds: null,
    })).toMatchObject({ url: 'https://ios-emulator.capgo.app/s/7b1e0d3f-2c50-4f9b-8d44-1c8f6e3b22d5/', finished_at: null, build_time_seconds: null })
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

  it('builds an agent-device command against the session URL', () => {
    expect(simulatorDeviceUrl('https://ios-emulator.capgo.app/s/11111111-1111-4111-8111-111111111111', 'agent-device/rpc')).toBe('https://ios-emulator.capgo.app/s/11111111-1111-4111-8111-111111111111/agent-device/rpc')
    expect(simulatorCommandRpc({ command: 'tap', x: 0.5, y: 0.25 })).toMatchObject({
      method: 'agent_device.command',
      params: { command: 'tap', positionals: ['0.5', '0.25'], flags: { x: 0.5, y: 0.25 }, input: { x: 0.5, y: 0.25 } },
    })
    expect(simulatorCommandRpc({ command: 'open', bundleId: 'app.capgo.capdemo' }).params.flags).toEqual({ bundleId: 'app.capgo.capdemo' })
    expect(simulatorCommandRpc({ command: 'screenshot' }).params).toMatchObject({ command: 'screenshot', positionals: [] })
  })

  it('stops reading a screenshot once it passes the byte cap', async () => {
    const chunk = new Uint8Array([1, 2, 3])
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      },
    })
    await expect(readCappedBytes(stream, 4)).rejects.toThrow('too-large')
    const small = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.close()
      },
    })
    await expect(readCappedBytes(small, 4)).resolves.toEqual(chunk)
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
    // The raw IPA, not a multipart form: the simulator host challenges large multipart uploads.
    const text = new TextDecoder().decode(await new Response(ipaUploadStream(new Blob(['ipa']).stream())).arrayBuffer())
    expect(text).toBe('ipa')
    await expect(new Response(ipaUploadStream(new Blob([new Uint8Array(8)]).stream(), 4)).arrayBuffer()).rejects.toThrow('too large')
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3))
        controller.enqueue(new Uint8Array(3))
        controller.close()
      },
    })
    await expect(new Response(ipaUploadStream(chunks, 4)).arrayBuffer()).rejects.toThrow('too large')
  })
})
