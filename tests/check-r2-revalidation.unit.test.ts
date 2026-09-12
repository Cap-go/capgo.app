import { describe, expect, it, vi } from 'vitest'
import { revalidateDeleteCandidatesAgainstAppVersions } from '../scripts/r2_trash_utils.ts'

describe('revalidateDeleteCandidatesAgainstAppVersions', () => {
  it('drops candidates that now have app_versions rows', async () => {
    const lookup = vi.fn(async (batch: string[]) => {
      if (batch.includes('orgs/a/apps/com.live/v/1.zip'))
        return ['orgs/a/apps/com.live/v/1.zip']
      return []
    })

    const { candidates, skippedCount } = await revalidateDeleteCandidatesAgainstAppVersions([
      { key: 'orgs/a/apps/com.live/v/1.zip', etag: '"live"' },
      { key: 'orgs/a/apps/com.orphan/v/2.zip', etag: '"orphan"' },
    ], lookup)

    expect(skippedCount).toBe(1)
    expect(candidates).toEqual([{ key: 'orgs/a/apps/com.orphan/v/2.zip', etag: '"orphan"' }])
    expect(lookup).toHaveBeenCalledOnce()
  })

  it('batches large candidate lists', async () => {
    const keys = Array.from({ length: 501 }, (_, i) => `orgs/a/apps/com.test/v/${i}.zip`)
    const lookup = vi.fn(async () => [])

    const { candidates, skippedCount } = await revalidateDeleteCandidatesAgainstAppVersions(
      keys.map(key => ({ key })),
      lookup,
    )

    expect(skippedCount).toBe(0)
    expect(candidates).toHaveLength(501)
    expect(lookup).toHaveBeenCalledTimes(11)
  })
})
