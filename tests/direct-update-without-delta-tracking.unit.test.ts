import { describe, expect, it } from 'vitest'
import { DIRECT_UPDATE_WITHOUT_DELTA_BENTO_EVENT, DIRECT_UPDATE_WITHOUT_DELTA_EVENT, buildDirectUpdateWithoutDeltaBentoEvent } from '../supabase/functions/_backend/utils/direct_update_without_delta_tracking.ts'

const base = {
  event: DIRECT_UPDATE_WITHOUT_DELTA_EVENT,
  orgId: 'org-1',
  appId: 'com.demo.app',
  orgName: 'Demo Org',
  appName: 'Demo',
}

describe('buildDirectUpdateWithoutDeltaBentoEvent', () => {
  it.concurrent('builds a Bento payload for Direct Update Without Delta', () => {
    expect(buildDirectUpdateWithoutDeltaBentoEvent(base)).toEqual({
      cron: '* * * * *',
      event: DIRECT_UPDATE_WITHOUT_DELTA_BENTO_EVENT,
      preferenceKey: 'direct_update_without_delta',
      uniqId: 'direct_update_without_delta:com.demo.app',
      data: {
        org_id: 'org-1',
        org_name: 'Demo Org',
        app_id: 'com.demo.app',
        app_name: 'Demo',
      },
    })
  })

  it.concurrent('includes the external tag when present', () => {
    const result = buildDirectUpdateWithoutDeltaBentoEvent({ ...base, tags: { external: true } })
    expect(result?.data.external).toBe(true)
  })

  it.concurrent('returns undefined for other event names', () => {
    expect(buildDirectUpdateWithoutDeltaBentoEvent({ ...base, event: 'App Too Large' })).toBeUndefined()
  })

  it.concurrent('returns undefined when org or app id is missing', () => {
    expect(buildDirectUpdateWithoutDeltaBentoEvent({ ...base, orgId: undefined })).toBeUndefined()
    expect(buildDirectUpdateWithoutDeltaBentoEvent({ ...base, appId: undefined })).toBeUndefined()
  })

  it.concurrent('defaults missing org and app names to empty strings', () => {
    const result = buildDirectUpdateWithoutDeltaBentoEvent({
      event: DIRECT_UPDATE_WITHOUT_DELTA_EVENT,
      orgId: 'org-1',
      appId: 'com.demo.app',
    })
    expect(result?.data.org_name).toBe('')
    expect(result?.data.app_name).toBe('')
  })
})
