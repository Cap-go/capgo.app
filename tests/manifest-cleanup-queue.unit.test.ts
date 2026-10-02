import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { manifestCleanupEnqueueApp, manifestCleanupQueueTestUtils } from '../supabase/functions/_backend/triggers/manifest_cleanup_queue.ts'

const originalApiSecret = process.env.API_SECRET

function enqueueRequest(body: string) {
  return manifestCleanupEnqueueApp.request(new Request('https://api.capgo.app/', {
    body,
    headers: {
      'apisecret': 'test-secret',
      'content-type': 'application/json',
    },
    method: 'POST',
  }))
}

describe('manifest cleanup queue messages', () => {
  beforeAll(() => {
    process.env.API_SECRET = 'test-secret'
  })

  afterAll(() => {
    if (originalApiSecret === undefined)
      delete process.env.API_SECRET
    else
      process.env.API_SECRET = originalApiSecret
  })

  it('keeps five row ids per message and includes a final partial message', () => {
    const ids = Array.from({ length: 101 }, (_, index) => index + 1)
    const messages = manifestCleanupQueueTestUtils.buildManifestCleanupMessages(42, ids)

    expect(messages).toHaveLength(21)
    expect(messages[0].body).toEqual({ versionId: 42, manifestIds: [1, 2, 3, 4, 5] })
    expect(messages[20].body).toEqual({ versionId: 42, manifestIds: [101] })
  })

  it('supports finalization-only messages and rejects oversized messages', () => {
    expect(manifestCleanupQueueTestUtils.buildManifestCleanupMessages(42, [])).toEqual([{ body: { versionId: 42, manifestIds: [] } }])
    expect(manifestCleanupQueueTestUtils.isManifestCleanupQueueMessage({ versionId: 42, manifestIds: [] })).toBe(true)
    expect(manifestCleanupQueueTestUtils.isManifestCleanupQueueMessage({ versionId: 42, manifestIds: [1, 2, 3, 4, 5, 6] })).toBe(false)
  })

  it('returns the request-validation error for missing, malformed, and null JSON bodies', async () => {
    for (const body of ['', '{', 'null']) {
      const response = await enqueueRequest(body)
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_manifest_cleanup_enqueue_request' })
    }
  })
})
