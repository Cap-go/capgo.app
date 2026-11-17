import { describe, expect, it } from 'vitest'
import { DeviceCountCache, MAX_DEVICES_PAGE_OFFSET as CONSOLE_MAX_DEVICES_PAGE_OFFSET, planDevicePageFetch, plannedDevicePage } from '../src/services/devicePagination'
import { groupPreviousDeploysByChannel } from '../src/services/bundleComparePrevious'
import { organizationAccessKey, organizationBillingKey, organizationIdentityKey, organizationSecurityKey } from '../src/services/organizationWatchKeys'
import { splitUpdateStatsAppIds, splitUpdateStatsWindow, toDailyVersionStat } from '../src/services/updateStats'
import { buildReadDevicesCFQuery } from '../supabase/functions/_backend/utils/cloudflare.ts'
import { devicesOffsetClause, MAX_DEVICES_PAGE_OFFSET } from '../supabase/functions/_backend/utils/devicesPageOffset.ts'
import { devicesPageOffsetSchema } from '../supabase/functions/_backend/utils/privateAnalyticsValidation.ts'

describe('device table page jumps', () => {
  const PAGE_SIZE = 10

  it('reaches the last of 5,000 pages in one request instead of walking every cursor', () => {
    const known = new Map<number, string | null | undefined>([[1, undefined]])
    const plan = planDevicePageFetch(known, 5_000, PAGE_SIZE)
    expect(plan).toEqual({ fromPage: 1, cursor: undefined, offset: 49_990 })
    expect(plannedDevicePage(plan!, PAGE_SIZE)).toBe(5_000)
  })

  it('starts from the closest known page at or before the target', () => {
    const known = new Map<number, string | null | undefined>([[1, undefined], [2, 'c2'], [3, 'c3'], [5_001, 'c5001']])
    expect(planDevicePageFetch(known, 3, PAGE_SIZE)).toEqual({ fromPage: 3, cursor: 'c3', offset: 0 })
    expect(planDevicePageFetch(known, 4, PAGE_SIZE)).toEqual({ fromPage: 3, cursor: 'c3', offset: 10 })
    // Going back from a far page: nearest earlier known page, not the furthest one.
    expect(planDevicePageFetch(known, 4_999, PAGE_SIZE)).toEqual({ fromPage: 3, cursor: 'c3', offset: 49_960 })
  })

  it('stops at a known end of the list', () => {
    const known = new Map<number, string | null | undefined>([[1, undefined], [2, null]])
    expect(planDevicePageFetch(known, 7, PAGE_SIZE)).toBeNull()
  })

  it('splits jumps longer than the offset bound', () => {
    const known = new Map<number, string | null | undefined>([[1, undefined]])
    const plan = planDevicePageFetch(known, 30_000, PAGE_SIZE)!
    expect(plan.offset).toBe(MAX_DEVICES_PAGE_OFFSET)
    expect(plannedDevicePage(plan, PAGE_SIZE)).toBe(10_001)
    known.set(10_002, 'next')
    expect(planDevicePageFetch(known, 15_000, PAGE_SIZE)).toEqual({ fromPage: 10_002, cursor: 'next', offset: 49_980 })
    expect(planDevicePageFetch(known, 30_000, PAGE_SIZE)).toEqual({ fromPage: 10_002, cursor: 'next', offset: MAX_DEVICES_PAGE_OFFSET })
  })

  it('keeps the console bound in sync with the API bound', () => {
    expect(CONSOLE_MAX_DEVICES_PAGE_OFFSET).toBe(MAX_DEVICES_PAGE_OFFSET)
  })

  it('caches counts with a bounded size', () => {
    const cache = new DeviceCountCache(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('c')).toBe(3)
    cache.clear()
    expect(cache.get('c')).toBeUndefined()
  })
})

describe('devices endpoint offset', () => {
  it('accepts bounded offsets only', () => {
    expect(devicesPageOffsetSchema.safeParse(0).success).toBe(true)
    expect(devicesPageOffsetSchema.safeParse(MAX_DEVICES_PAGE_OFFSET).success).toBe(true)
    expect(devicesPageOffsetSchema.safeParse(MAX_DEVICES_PAGE_OFFSET + 1).success).toBe(false)
    expect(devicesPageOffsetSchema.safeParse(-1).success).toBe(false)
    expect(devicesPageOffsetSchema.safeParse(1.5).success).toBe(false)
    expect(devicesPageOffsetSchema.safeParse('10').success).toBe(false)
  })

  it('renders an OFFSET clause only for a positive integer', () => {
    expect(devicesOffsetClause(undefined)).toBe('')
    expect(devicesOffsetClause(0)).toBe('')
    expect(devicesOffsetClause(30)).toBe('OFFSET 30')
    expect(devicesOffsetClause(MAX_DEVICES_PAGE_OFFSET * 3)).toBe(`OFFSET ${MAX_DEVICES_PAGE_OFFSET}`)
  })

  it('skips rows after the cursor in the Analytics Engine query', () => {
    const query = buildReadDevicesCFQuery({
      app_id: 'com.example.app',
      cursor: '2026-11-01 00:00:00|device-1',
      order: [{ key: 'updated_at', sortable: 'desc' }],
      limit: 10,
      offset: 40,
    }, false)
    expect(query).toMatch(/ORDER BY updated_at DESC, device_id ASC\nLIMIT 11\nOFFSET 40$/)
    expect(buildReadDevicesCFQuery({ app_id: 'com.example.app', limit: 10 }, false)).not.toContain('OFFSET')
  })
})

describe('update stats aggregation', () => {
  it('asks for one window for a normal billing cycle', () => {
    expect(splitUpdateStatsWindow('2026-10-17', '2026-11-16')).toEqual([{ start: '2026-10-17', end: '2026-11-16' }])
  })

  it('splits an old subscription start into windows the RPC accepts', () => {
    const windows = splitUpdateStatsWindow('2024-01-01', '2026-11-16')
    expect(windows[0]).toEqual({ start: '2024-01-01', end: '2024-12-31' })
    expect(windows.at(-1)!.end).toBe('2026-11-16')
    for (let index = 1; index < windows.length; index++) {
      const previousEnd = Date.parse(`${windows[index - 1]!.end}T00:00:00Z`)
      expect(Date.parse(`${windows[index]!.start}T00:00:00Z`) - previousEnd).toBe(86_400_000)
    }
  })

  it('splits more than 1000 apps into disjoint chunks the RPC accepts', () => {
    const appIds = Array.from({ length: 2_001 }, (_, index) => `com.example.app${index}`)
    const chunks = splitUpdateStatsAppIds(appIds)
    expect(chunks.map(chunk => chunk.length)).toEqual([1_000, 1_000, 1])
    expect(chunks.flat()).toEqual(appIds)
    expect(splitUpdateStatsAppIds([])).toEqual([])
  })

  it('maps aggregated rows (bigint counts may arrive as strings)', () => {
    expect(toDailyVersionStat({ app_id: 'com.example.app', date: '2026-11-16', install_count: '12', fail_count: 1, get_count: null }))
      .toEqual({ app_id: 'com.example.app', date: '2026-11-16', install: 12, fail: 1, get: 0 })
  })
})

describe('organization watch keys', () => {
  const org = {
    'gid': 'org-1',
    'role': 'org_admin',
    'logo': 'https://example.com/a.png',
    'logo_is_loading': true,
    'name': 'Example',
    'paying': true,
    'enforcing_2fa': false,
    '2fa_has_access': true,
    'password_policy_config': { enabled: false },
    'require_apikey_expiration': false,
  }

  it('ignores a signed logo or loading flag replacing the organization object', () => {
    const refreshed = { ...org, logo: 'https://example.com/signed.png', logo_is_loading: false }
    for (const key of [organizationIdentityKey, organizationAccessKey, organizationSecurityKey, organizationBillingKey])
      expect(key(refreshed)).toBe(key(org))
  })

  it('changes on organization switch, role change, or a field the watcher depends on', () => {
    expect(organizationIdentityKey({ ...org, gid: 'org-2' })).not.toBe(organizationIdentityKey(org))
    expect(organizationIdentityKey({ ...org, role: 'org_member' })).not.toBe(organizationIdentityKey(org))
    expect(organizationSecurityKey({ ...org, require_apikey_expiration: true })).not.toBe(organizationSecurityKey(org))
    expect(organizationAccessKey({ ...org, password_policy_config: { enabled: true } })).not.toBe(organizationAccessKey(org))
    expect(organizationBillingKey({ ...org, paying: false })).not.toBe(organizationBillingKey(org))
    expect(organizationIdentityKey(undefined)).toBe('')
  })
})

describe('bundle compare previous deployments', () => {
  it('groups one batched response per channel, in request order, skipping empty channels', () => {
    const grouped = groupPreviousDeploysByChannel([3, 1, 2], [
      { channel_id: 1, version_id: 10, created_at: '2026-11-02', deployed_at: null },
      { channel_id: 1, version_id: 9, created_at: null, deployed_at: '2026-11-01' },
      { channel_id: 3, version_id: 7, created_at: '2026-10-01', deployed_at: '2026-10-01' },
    ])
    expect(grouped).toEqual([
      [{ versionId: 7, deployedAt: '2026-10-01' }],
      [{ versionId: 10, deployedAt: '2026-11-02' }, { versionId: 9, deployedAt: '2026-11-01' }],
    ])
  })
})
