import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trackAiAnalysisChoice, trackAiAnalysisResult } from '../cli/src/ai/telemetry.ts'

const sendEventMock = vi.hoisted(() => vi.fn())

vi.mock('../cli/src/utils.ts', () => ({
  sendEvent: sendEventMock,
}))

describe('trackAiAnalysisChoice', () => {
  beforeEach(() => {
    sendEventMock.mockReset()
    sendEventMock.mockResolvedValue(undefined)
  })

  it.each([
    ['capgo_ai', 'menu'] as const,
    ['local_ai', 'menu'] as const,
    ['skip', 'menu'] as const,
    ['auto_upload', 'ci_flag'] as const,
  ])('emits the expected payload for choice=%s triggeredBy=%s', async (choice, triggeredBy) => {
    await trackAiAnalysisChoice({
      apikey: 'cap_test_key',
      orgId: 'org-uuid-1',
      appId: 'com.example.app',
      platform: 'ios',
      jobId: 'job-abc',
      choice,
      triggeredBy,
    })

    expect(sendEventMock).toHaveBeenCalledTimes(1)
    const [calledKey, payload] = sendEventMock.mock.calls[0]
    expect(calledKey).toBe('cap_test_key')
    expect(payload).toMatchObject({
      event: 'CLI AI Build Analysis Choice',
      channel: 'build-lifecycle',
      org_id: 'org-uuid-1',
      tracking_version: 2,
      tags: {
        app_id: 'com.example.app',
        platform: 'ios',
        job_id: 'job-abc',
        choice,
        triggered_by: triggeredBy,
      },
    })
  })

  it('swallows errors thrown by sendEvent', async () => {
    sendEventMock.mockRejectedValueOnce(new Error('network down'))
    await expect(trackAiAnalysisChoice({
      apikey: 'cap_test_key',
      orgId: 'org-uuid-1',
      appId: 'com.example.app',
      platform: 'android',
      jobId: 'job-abc',
      choice: 'skip',
      triggeredBy: 'menu',
    })).resolves.toBeUndefined()
  })
})

describe('trackAiAnalysisResult', () => {
  beforeEach(() => {
    sendEventMock.mockReset()
    sendEventMock.mockResolvedValue(undefined)
  })

  it.each([
    'success',
    'already_analyzed',
    'too_big',
  ] as const)('emits the expected payload for result=%s without error_status', async (result) => {
    await trackAiAnalysisResult({
      apikey: 'cap_test_key',
      orgId: 'org-uuid-1',
      appId: 'com.example.app',
      platform: 'ios',
      jobId: 'job-abc',
      result,
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload).toMatchObject({
      event: 'CLI AI Build Analysis Result',
      channel: 'build-lifecycle',
      org_id: 'org-uuid-1',
      tracking_version: 2,
      tags: {
        app_id: 'com.example.app',
        platform: 'ios',
        job_id: 'job-abc',
        result,
      },
    })
    expect(payload.tags.error_status).toBeUndefined()
  })

  it('emits error with error_status when provided', async () => {
    await trackAiAnalysisResult({
      apikey: 'cap_test_key',
      orgId: 'org-uuid-1',
      appId: 'com.example.app',
      platform: 'android',
      jobId: 'job-abc',
      result: 'error',
      errorStatus: 503,
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload.tags.result).toBe('error')
    expect(payload.tags.error_status).toBe('503')
  })

  it('omits error_status when result is not error, even if errorStatus is provided', async () => {
    await trackAiAnalysisResult({
      apikey: 'cap_test_key',
      orgId: 'org-uuid-1',
      appId: 'com.example.app',
      platform: 'ios',
      jobId: 'job-abc',
      result: 'success',
      errorStatus: 200,
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload.tags.error_status).toBeUndefined()
  })

  it('omits error_status when result is error but errorStatus is undefined (no status, e.g. network error)', async () => {
    await trackAiAnalysisResult({
      apikey: 'cap_test_key',
      orgId: 'org-uuid-1',
      appId: 'com.example.app',
      platform: 'ios',
      jobId: 'job-abc',
      result: 'error',
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload.tags.result).toBe('error')
    expect(payload.tags.error_status).toBeUndefined()
  })

  it('swallows errors thrown by sendEvent', async () => {
    sendEventMock.mockRejectedValueOnce(new Error('network down'))
    await expect(trackAiAnalysisResult({
      apikey: 'cap_test_key',
      orgId: 'org-uuid-1',
      appId: 'com.example.app',
      platform: 'ios',
      jobId: 'job-abc',
      result: 'success',
    })).resolves.toBeUndefined()
  })
})
