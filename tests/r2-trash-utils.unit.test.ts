import { describe, expect, it } from 'vitest'
import {
  ConcurrencyLimiter,
  encodeS3CopySource,
  getR2TrashKey,
  isLiveR2Key,
  resolveOpsDeleteMode,
  R2_TRASH_PREFIX,
} from '../scripts/r2_trash_utils.ts'

describe('resolveOpsDeleteMode', () => {
  it('defaults to dry_run', () => {
    expect(resolveOpsDeleteMode({})).toBe('dry_run')
    expect(resolveOpsDeleteMode({ DRY_RUN: 'true' })).toBe('dry_run')
  })

  it('uses trash when executing without permanent flag', () => {
    expect(resolveOpsDeleteMode({ DRY_RUN: 'false' })).toBe('trash')
  })

  it('requires ALLOW_PERMANENT_R2_DELETE=true for permanent mode', () => {
    expect(resolveOpsDeleteMode({
      DRY_RUN: 'false',
      ALLOW_PERMANENT_R2_DELETE: 'true',
    })).toBe('permanent')
  })
})

describe('getR2TrashKey', () => {
  it('prefixes live keys with deleted-after-7-days/', () => {
    expect(getR2TrashKey('orgs/org-1/apps/com.test/1.0.0.zip'))
      .toBe('deleted-after-7-days/orgs/org-1/apps/com.test/1.0.0.zip')
  })

  it('leaves already-trashed keys unchanged', () => {
    const trashed = 'deleted-after-7-days/orgs/org-1/apps/com.test/1.0.0.zip'
    expect(getR2TrashKey(trashed)).toBe(trashed)
  })
})

describe('isLiveR2Key', () => {
  it('treats deleted-after-7-days keys as not live', () => {
    expect(isLiveR2Key(`${R2_TRASH_PREFIX}orgs/org-1/a.zip`)).toBe(false)
    expect(isLiveR2Key('orgs/org-1/a.zip')).toBe(true)
  })
})

describe('encodeS3CopySource', () => {
  it('URL-encodes reserved characters per path segment', () => {
    expect(encodeS3CopySource('capgo', 'orgs/org-1/apps/com.test/file name.zip'))
      .toBe('capgo/orgs/org-1/apps/com.test/file%20name.zip')
    expect(encodeS3CopySource('capgo', 'orgs/org-1/apps/com.test/文件.zip'))
      .toBe('capgo/orgs/org-1/apps/com.test/%E6%96%87%E4%BB%B6.zip')
  })
})

describe('ConcurrencyLimiter', () => {
  it('caps concurrent work to the configured limit', async () => {
    const limiter = new ConcurrencyLimiter(2)
    let inFlight = 0
    let maxInFlight = 0

    await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight -= 1
    })))

    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(maxInFlight).toBeGreaterThan(1)
  })
})
