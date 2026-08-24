import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mapBuilderUploadError, trackBuilderUpload } from '../cli/src/build/telemetry.ts'

const sendEventMock = vi.hoisted(() => vi.fn())

vi.mock('../cli/src/utils.ts', () => ({
  sendEvent: sendEventMock,
}))

describe('mapBuilderUploadError', () => {
  it.concurrent('maps HTTP 401 to unauthorized', () => {
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 401 } })).toBe('unauthorized')
  })
  it.concurrent('maps HTTP 403 to unauthorized', () => {
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 403 } })).toBe('unauthorized')
  })
  it.concurrent('maps HTTP 413 to payload_too_large', () => {
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 413 } })).toBe('payload_too_large')
  })
  it.concurrent('maps HTTP 500-599 to storage_failure', () => {
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 500 } })).toBe('storage_failure')
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 502 } })).toBe('storage_failure')
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 599 } })).toBe('storage_failure')
  })
  it.concurrent('maps no-response (connection-level) errors to network_error', () => {
    expect(mapBuilderUploadError(new Error('ECONNRESET'))).toBe('network_error')
    expect(mapBuilderUploadError({ originalResponse: undefined })).toBe('network_error')
    expect(mapBuilderUploadError(null)).toBe('network_error')
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 0 } })).toBe('network_error')
  })
  it.concurrent('maps other HTTP statuses to unknown', () => {
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 418 } })).toBe('unknown')
    expect(mapBuilderUploadError({ originalResponse: { getStatus: () => 404 } })).toBe('unknown')
  })
})

describe('trackBuilderUpload', () => {
  beforeEach(() => {
    sendEventMock.mockReset()
    sendEventMock.mockResolvedValue(undefined)
  })

  it('emits Builder Upload Started with size but no duration or failure_category', async () => {
    await trackBuilderUpload({
      apikey: 'cap_test_key',
      appId: 'com.example.app',
      orgId: 'org-uuid-1',
      platform: 'ios',
      buildMode: 'release',
      jobId: 'job-abc',
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
      apikey: 'cap_test_key',
      appId: 'com.example.app',
      orgId: 'org-uuid-1',
      platform: 'android',
      buildMode: 'release',
      jobId: 'job-abc',
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
      apikey: 'cap_test_key',
      appId: 'com.example.app',
      orgId: 'org-uuid-1',
      platform: 'ios',
      buildMode: 'release',
      jobId: 'job-abc',
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
      apikey: 'cap_test_key',
      appId: 'com.example.app',
      orgId: 'org-uuid-1',
      platform: 'ios',
      buildMode: 'release',
      jobId: 'job-abc',
      sizeBytes: 1,
      phase: 'started',
    })).resolves.toBeUndefined()
  })
})
