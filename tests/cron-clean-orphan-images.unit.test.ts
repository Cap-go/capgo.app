import { describe, expect, it } from 'vitest'
import { getStaleOrgLogoPaths, runWithDeadline } from '../supabase/functions/_backend/triggers/cron_clean_orphan_images.ts'

describe('getStaleOrgLogoPaths', () => {
  it.concurrent.each([
    ['keeps the linked org logo file and skips folders', 'org/org-123/logo/current.png', [{ name: 'current.png', isFolder: false }, { name: 'older.png', isFolder: false }, { name: 'nested-folder', isFolder: true }], ['older.png']],
    ['treats signed logo URLs as the linked file path', 'https://sb.capgo.app/storage/v1/object/sign/images/org/org-123/logo/facebook.com.png?token=abc', [{ name: 'facebook.com.png', isFolder: false }, { name: 'fallback.png', isFolder: false }], ['fallback.png']],
    ['decodes signed logo URLs before comparing file names', 'https://sb.capgo.app/storage/v1/object/sign/images/org/org-123/logo/company%20logo.png?token=abc', [{ name: 'company logo.png', isFolder: false }, { name: 'fallback.png', isFolder: false }], ['fallback.png']],
    ['treats raw logo paths with a leading /images prefix as the linked file path', '/images/org/org-123/logo/current.png', [{ name: 'current.png', isFolder: false }, { name: 'older.png', isFolder: false }], ['older.png']],
    ['deletes all org logo files when no linked logo remains', null, [{ name: 'first.png', isFolder: false }, { name: 'second.png', isFolder: false }], ['first.png', 'second.png']],
  ] as const)('%s', (_name, linkedLogo, files, stale) => {
    expect(getStaleOrgLogoPaths('org-123', [...files], linkedLogo)).toEqual(stale.map(name => `org/org-123/logo/${name}`))
  })
})

describe('runWithDeadline', () => {
  it.concurrent('processes every item before the deadline with bounded concurrency', async () => {
    let active = 0
    let maxActive = 0
    const seen: number[] = []
    const started = await runWithDeadline([1, 2, 3, 4, 5], async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      seen.push(item)
      active--
    }, { concurrency: 2, deadline: Date.now() + 60_000 })

    expect(started).toBe(5)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
    expect(maxActive).toBe(2)
  })

  it.concurrent('stops starting items once the deadline passes', async () => {
    let clock = 0
    const seen: number[] = []
    const started = await runWithDeadline([1, 2, 3, 4], async (item) => {
      seen.push(item)
      clock += 10
    }, { concurrency: 1, deadline: 15, now: () => clock })

    expect(started).toBe(2)
    expect(seen).toEqual([1, 2])
  })
})
