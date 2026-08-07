import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cloudlogMock,
  sendEventToTrackingMock,
} = vi.hoisted(() => ({
  cloudlogMock: vi.fn(),
  sendEventToTrackingMock: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: sendEventToTrackingMock,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

const ORG_BUNDLES = 'a0c1e2f3-1111-4aaa-8bbb-000000000101'
const ORG_APPS = 'a0c1e2f3-1111-4aaa-8bbb-000000000102'
const ORG_BAD = 'a0c1e2f3-1111-4aaa-8bbb-000000000103'
const ORG_PROTO = 'a0c1e2f3-1111-4aaa-8bbb-000000000104'
const ORG_FALLBACK = 'a0c1e2f3-1111-4aaa-8bbb-000000000105'

async function postRetentionAlert(body: unknown) {
  const { app } = await import('../supabase/functions/_backend/triggers/canceled_org_retention_alerts.ts')
  return app.request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('canceled_org_retention_alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendEventToTrackingMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('sends a once Bento/tracking event for bundle deletion warnings', async () => {
    const response = await postRetentionAlert({
      org_id: ORG_BUNDLES,
      org_name: 'Retention Org',
      management_email: 'billing@example.com',
      alert_type: 'bundles_deletion_warning',
      access_end: '2026-05-01T00:00:00.000Z',
      days_until_deletion: 5,
      app_ids: ['com.example.app'],
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(sendEventToTrackingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: 'usage',
        event: 'Bundles will be deleted',
        sentToBento: true,
        user_id: ORG_BUNDLES,
        groups: { organization: ORG_BUNDLES },
        bento: expect.objectContaining({
          once: true,
          event: 'org:bundles_will_be_deleted',
          preferenceKey: 'usage_limit',
          audience: 'billing',
          uniqId: 'retention:bundles_deletion_warning:2026-05-01T00:00:00Z',
          data: expect.objectContaining({
            org_id: ORG_BUNDLES,
            app_ids: ['com.example.app'],
            days_until_deletion: 5,
          }),
        }),
      }),
      { background: false, strict: true },
    )
  })

  it('sends a once Bento/tracking event for app deletion warnings', async () => {
    const response = await postRetentionAlert({
      org_id: ORG_APPS,
      org_name: 'Retention Org',
      alert_type: 'app_deletion_warning',
      access_end: '2026-04-20T12:30:00.000Z',
      app_ids: ['com.example.one', 'com.example.two'],
    })

    expect(response.status).toBe(200)
    expect(sendEventToTrackingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'Apps will be deleted',
        bento: expect.objectContaining({
          once: true,
          event: 'org:apps_will_be_deleted',
          uniqId: 'retention:app_deletion_warning:2026-04-20T12:30:00Z',
          data: expect.objectContaining({
            app_count: 2,
          }),
        }),
      }),
      { background: false, strict: true },
    )
  })

  it('rejects unsupported alert types', async () => {
    const response = await postRetentionAlert({
      org_id: ORG_BAD,
      alert_type: 'not_a_real_alert',
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it.each(['constructor', 'toString', 'valueOf'])('rejects prototype key %s as alert type', async (alertType) => {
    const response = await postRetentionAlert({
      org_id: ORG_PROTO,
      alert_type: alertType,
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('rejects missing org_id', async () => {
    const response = await postRetentionAlert({
      alert_type: 'bundles_deletion_warning',
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('rejects null JSON body without 500', async () => {
    const response = await postRetentionAlert(null)

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('rejects non-uuid org_id', async () => {
    const response = await postRetentionAlert({
      org_id: 'not-a-uuid',
      alert_type: 'bundles_deletion_warning',
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('falls back access_end uniqId and NaN days_until_deletion', async () => {
    const response = await postRetentionAlert({
      org_id: ORG_FALLBACK,
      alert_type: 'app_deletion_warning',
      access_end: 'not-a-date',
      days_until_deletion: 'nope',
    })

    expect(response.status).toBe(200)
    expect(sendEventToTrackingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bento: expect.objectContaining({
          uniqId: 'retention:app_deletion_warning:invalid',
          data: expect.objectContaining({
            days_until_deletion: 5,
          }),
        }),
      }),
      { background: false, strict: true },
    )
  })

  it('rejects non-string access_end without 500', async () => {
    const response = await postRetentionAlert({
      org_id: ORG_FALLBACK,
      alert_type: 'bundles_deletion_warning',
      access_end: { nested: true },
    })

    expect(response.status).toBe(200)
    expect(sendEventToTrackingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bento: expect.objectContaining({
          uniqId: 'retention:bundles_deletion_warning:unknown',
        }),
      }),
      { background: false, strict: true },
    )
  })
})
