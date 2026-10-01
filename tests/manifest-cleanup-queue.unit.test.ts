import { describe, expect, it } from 'vitest'
import { manifestCleanupQueueTestUtils } from '../supabase/functions/_backend/triggers/manifest_cleanup_queue.ts'

describe('manifest cleanup queue messages', () => {
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
})
