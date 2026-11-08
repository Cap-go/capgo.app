import { describe, expect, it, vi } from 'vitest'

const sendEventMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../cli/src/utils.ts', () => ({
  sendEvent: sendEventMock,
}))

const { sendUploadZipPerformanceEvent } = await import('../cli/src/bundle/upload.ts')

describe('cli posthog volume guardrails', () => {
  it.concurrent('emits zip performance only for non TUS uploads', async () => {
    sendEventMock.mockClear()
    await sendUploadZipPerformanceEvent('capgo-key', 'org-1', 'com.example.app', '1.23', true)
    expect(sendEventMock).not.toHaveBeenCalled()

    await sendUploadZipPerformanceEvent('capgo-key', 'org-1', 'com.example.app', '4.56', false)
    expect(sendEventMock).toHaveBeenCalledOnce()
    expect(sendEventMock.mock.calls[0]?.[1]).toMatchObject({
      channel: 'performance',
      event: 'Upload zip performance',
      org_id: 'org-1',
      tags: {
        'app-id': 'com.example.app',
        'time': '4.56',
      },
    })
  })
})
