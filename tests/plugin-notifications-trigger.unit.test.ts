import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { closeClientMock, sendNotifOrgMock, sendNotifToOrgMembersOnceMock } = vi.hoisted(() => ({
  closeClientMock: vi.fn(),
  sendNotifOrgMock: vi.fn(),
  sendNotifToOrgMembersOnceMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn(error => error),
}))

vi.mock('../supabase/functions/_backend/utils/notifications.ts', () => ({
  sendNotifOrg: sendNotifOrgMock,
}))

vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembersOnce: sendNotifToOrgMembersOnceMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getDrizzleClient: vi.fn(pgClient => ({ pgClient })),
  getPgClient: vi.fn(() => ({ id: 'pg-client' })),
}))

const API_SECRET = 'testsecret'
const originalApiSecret = process.env.API_SECRET

function orgQueueItem() {
  return {
    type: 'org' as const,
    eventName: 'org:missing_payment',
    eventData: { app_id: 'com.test.app' },
    orgId: 'org-1',
    uniqId: 'com.test.app',
    cron: '0 0 * * 1',
    managementEmail: 'owner@example.com',
    enqueuedAt: new Date().toISOString(),
  }
}

function orgMembersQueueItem() {
  return {
    type: 'org_members' as const,
    eventName: 'device:channel_self_set_rejected',
    preferenceKey: 'channel_self_rejected' as const,
    eventData: { app_id: 'com.test.app' },
    orgId: 'org-1',
    uniqId: 'com.test.app',
    cron: '0 0 * * 0',
    audience: 'admins' as const,
    enqueuedAt: new Date().toISOString(),
  }
}

async function requestPluginNotifications(items: unknown[]) {
  const { app } = await import('../supabase/functions/_backend/triggers/plugin_notifications.ts')
  return await app.request('http://local/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apisecret': API_SECRET,
    },
    body: JSON.stringify({ items }),
  })
}

describe('plugin notification trigger', () => {
  beforeEach(() => {
    process.env.API_SECRET = API_SECRET
    closeClientMock.mockResolvedValue(undefined)
    sendNotifOrgMock.mockReset()
    sendNotifToOrgMembersOnceMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (originalApiSecret === undefined)
      delete process.env.API_SECRET
    else
      process.env.API_SECRET = originalApiSecret
  })

  it('returns non-2xx when a queued org notification is not delivered', async () => {
    sendNotifOrgMock.mockResolvedValue(false)

    const response = await requestPluginNotifications([orgQueueItem()])
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('Plugin notification batch failed')
    expect(sendNotifOrgMock).toHaveBeenCalledTimes(1)
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })

  it('accepts queued org notifications that are already throttled by cron', async () => {
    const lastSendAt = new Date().toISOString()
    sendNotifOrgMock.mockResolvedValue({ sent: false, lastSendAt })

    const response = await requestPluginNotifications([orgQueueItem()])
    const body = await response.json() as { failed: number, processed: number, results: Array<{ lastSendAt?: string, status: string }>, throttled: number }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ processed: 1, failed: 0, throttled: 1 })
    expect(body.results).toEqual([{ status: 'throttled', lastSendAt }])
  })

  it('accepts delivered org member notifications after durable per-recipient delivery', async () => {
    sendNotifToOrgMembersOnceMock.mockResolvedValue(true)

    const response = await requestPluginNotifications([orgMembersQueueItem()])
    const body = await response.json() as { processed: number, failed: number }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ processed: 1, failed: 0 })
    expect(sendNotifToOrgMembersOnceMock).toHaveBeenCalledTimes(1)
    expect(sendNotifToOrgMembersOnceMock).toHaveBeenCalledWith(
      expect.anything(),
      'device:channel_self_set_rejected',
      'channel_self_rejected',
      { app_id: 'com.test.app' },
      'org-1',
      'com.test.app',
      expect.objectContaining({ pgClient: { id: 'pg-client' } }),
      'admins',
    )
  })

  it('returns non-2xx when durable org member notification processing throws', async () => {
    sendNotifToOrgMembersOnceMock.mockRejectedValue(new Error('bento unavailable'))

    const response = await requestPluginNotifications([orgMembersQueueItem()])
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toContain('Plugin notification batch failed')
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })

  it('returns an ok no-op for empty batches', async () => {
    const response = await requestPluginNotifications([])
    const body = await response.json() as { processed: number, failed: number }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ processed: 0, failed: 0 })
    expect(sendNotifOrgMock).not.toHaveBeenCalled()
    expect(closeClientMock).not.toHaveBeenCalled()
  })

  it('filters invalid queued items without opening a database client', async () => {
    const response = await requestPluginNotifications([{ type: 'org', orgId: 'org-1' }])
    const body = await response.json() as { processed: number, failed: number, invalid: number }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ processed: 0, failed: 0, invalid: 1 })
    expect(sendNotifOrgMock).not.toHaveBeenCalled()
    expect(closeClientMock).not.toHaveBeenCalled()
  })

  it('rejects batches above the maximum size', async () => {
    const response = await requestPluginNotifications(Array.from({ length: 101 }, orgQueueItem))
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).toContain('Too many plugin notification items')
    expect(sendNotifOrgMock).not.toHaveBeenCalled()
  })
})
