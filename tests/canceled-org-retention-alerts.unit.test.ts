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

async function postRetentionAlert(body: Record<string, unknown>) {
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
      org_id: 'org-retention-bundles',
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
        user_id: 'org-retention-bundles',
        groups: { organization: 'org-retention-bundles' },
        bento: expect.objectContaining({
          once: true,
          event: 'org:bundles_will_be_deleted',
          preferenceKey: 'usage_limit',
          audience: 'billing',
          uniqId: 'retention:bundles_deletion_warning:2026-05-01',
          data: expect.objectContaining({
            org_id: 'org-retention-bundles',
            app_ids: ['com.example.app'],
            days_until_deletion: 5,
          }),
        }),
      }),
      { background: false },
    )
  })

  it('sends a once Bento/tracking event for app deletion warnings', async () => {
    const response = await postRetentionAlert({
      org_id: 'org-retention-apps',
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
          uniqId: 'retention:app_deletion_warning:2026-04-20',
          data: expect.objectContaining({
            app_count: 2,
          }),
        }),
      }),
      { background: false },
    )
  })

  it('rejects unsupported alert types', async () => {
    const response = await postRetentionAlert({
      org_id: 'org-retention-bad',
      alert_type: 'not_a_real_alert',
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })
})
