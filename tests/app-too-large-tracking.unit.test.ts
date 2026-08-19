import { describe, expect, it } from 'vitest'
import { APP_TOO_LARGE_BENTO_EVENT, APP_TOO_LARGE_EVENT, buildAppTooLargeBentoEvent } from '../supabase/functions/_backend/utils/app_too_large_tracking.ts'

const base = {
  event: APP_TOO_LARGE_EVENT,
  orgId: 'org-1',
  appId: 'com.demo.app',
  orgName: 'Demo Org',
  appName: 'Demo',
  tags: { size_mb: 42 },
}

describe('buildAppTooLargeBentoEvent', () => {
  it.concurrent('builds a Bento payload for App Too Large', () => {
    expect(buildAppTooLargeBentoEvent(base)).toEqual({
      cron: '* * * * *',
      event: APP_TOO_LARGE_BENTO_EVENT,
      preferenceKey: 'app_too_large',
      uniqId: 'app_too_large:com.demo.app',
      data: {
        org_id: 'org-1',
        org_name: 'Demo Org',
        app_id: 'com.demo.app',
        app_name: 'Demo',
        size_mb: 42,
      },
    })
  })

  it.concurrent('parses size_mb from a string tag', () => {
    const result = buildAppTooLargeBentoEvent({ ...base, tags: { size_mb: '21' } })
    expect(result?.data.size_mb).toBe(21)
  })

  it.concurrent('omits size_mb when the tag is missing or invalid', () => {
    expect(buildAppTooLargeBentoEvent({ ...base, tags: undefined })?.data).not.toHaveProperty('size_mb')
    expect(buildAppTooLargeBentoEvent({ ...base, tags: { size_mb: 'nope' } })?.data).not.toHaveProperty('size_mb')
    expect(buildAppTooLargeBentoEvent({ ...base, tags: { size_mb: '   ' } })?.data).not.toHaveProperty('size_mb')
    expect(buildAppTooLargeBentoEvent({ ...base, tags: { size_mb: -1 } })?.data).not.toHaveProperty('size_mb')
  })

  it.concurrent('returns undefined for other event names', () => {
    expect(buildAppTooLargeBentoEvent({ ...base, event: 'Bundle Incompatible' })).toBeUndefined()
  })

  it.concurrent('returns undefined when org or app id is missing', () => {
    expect(buildAppTooLargeBentoEvent({ ...base, orgId: undefined })).toBeUndefined()
    expect(buildAppTooLargeBentoEvent({ ...base, appId: undefined })).toBeUndefined()
  })

  it.concurrent('defaults missing org and app names to empty strings', () => {
    const result = buildAppTooLargeBentoEvent({
      event: APP_TOO_LARGE_EVENT,
      orgId: 'org-1',
      appId: 'com.demo.app',
    })
    expect(result?.data.org_name).toBe('')
    expect(result?.data.app_name).toBe('')
  })
})
