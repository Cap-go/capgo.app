import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mapBuilderUploadError, trackBuilderUpload } from '../cli/src/build/telemetry.ts'

const sendEventMock = vi.hoisted(() => vi.fn())

vi.mock('../cli/src/utils.ts', () => ({
  sendEvent: sendEventMock,
}))

const httpError = (status: number) => ({ originalResponse: { getStatus: () => status } })

describe('mapBuilderUploadError', () => {
  it.concurrent.each([
    [httpError(401), 'unauthorized'],
    [httpError(403), 'unauthorized'],
    [httpError(413), 'payload_too_large'],
    [httpError(500), 'storage_failure'],
    [httpError(502), 'storage_failure'],
    [httpError(599), 'storage_failure'],
    // no-response (connection-level) errors
    [new Error('ECONNRESET'), 'network_error'],
    [{ originalResponse: undefined }, 'network_error'],
    [null, 'network_error'],
    [httpError(0), 'network_error'],
    [httpError(418), 'unknown'],
    [httpError(404), 'unknown'],
  ])('maps %o to %s', (error, expected) => {
    expect(mapBuilderUploadError(error)).toBe(expected)
  })
})

const base = { apikey: 'cap_test_key', appId: 'com.example.app', orgId: 'org-uuid-1', buildMode: 'release', jobId: 'job-abc' } as const

describe('trackBuilderUpload', () => {
  beforeEach(() => {
    sendEventMock.mockReset()
    sendEventMock.mockResolvedValue(undefined)
  })

  it('emits Builder Upload Started with size but no duration or failure_category', async () => {
    await trackBuilderUpload({
      ...base,
      platform: 'ios',
      sizeBytes: 12_345_678,
      phase: 'started',
    })

    expect(sendEventMock).toHaveBeenCalledTimes(1)
    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload).toMatchObject({
      event: 'Builder Upload Started',
      channel: 'build-lifecycle',
      org_id: 'org-uuid-1',
      tracking_version: 2,
      tags: {
        app_id: 'com.example.app',
        platform: 'ios',
        build_mode: 'release',
        job_id: 'job-abc',
        upload_size_bytes: '12345678',
      },
    })
    expect(payload.tags.upload_duration_seconds).toBeUndefined()
    expect(payload.tags.failure_category).toBeUndefined()
  })

  it('emits Builder Upload Succeeded with duration and size', async () => {
    await trackBuilderUpload({
      ...base,
      platform: 'android',
      sizeBytes: 12_345_678,
      phase: 'succeeded',
      durationSeconds: 42.7,
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload).toMatchObject({
      event: 'Builder Upload Succeeded',
      tags: {
        platform: 'android',
        upload_duration_seconds: '43',
      },
    })
  })

  it('emits Builder Upload Failed with failure_category from a 413', async () => {
    await trackBuilderUpload({
      ...base,
      platform: 'ios',
      sizeBytes: 999_999,
      phase: 'failed',
      durationSeconds: 5,
      error: { originalResponse: { getStatus: () => 413 } },
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload).toMatchObject({
      event: 'Builder Upload Failed',
      tags: {
        failure_category: 'payload_too_large',
        upload_duration_seconds: '5',
      },
    })
  })

  it('swallows errors thrown by sendEvent', async () => {
    sendEventMock.mockRejectedValueOnce(new Error('network down'))
    await expect(trackBuilderUpload({
      ...base,
      platform: 'ios',
      sizeBytes: 1,
      phase: 'started',
    })).resolves.toBeUndefined()
  })
})
