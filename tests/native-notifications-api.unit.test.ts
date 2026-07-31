import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  checkPermissionMock,
  closeClientMock,
  executeMock,
  getDrizzleClientMock,
  getPgClientMock,
} = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  closeClientMock: vi.fn(),
  executeMock: vi.fn(),
  getDrizzleClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareKey: () => async (_c: unknown, next: () => Promise<void>) => next(),
  middlewareV2: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/rbac.ts')>()
  return {
    ...actual,
    checkPermission: checkPermissionMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  return {
    ...actual,
    closeClient: closeClientMock,
    getDrizzleClient: getDrizzleClientMock,
    getPgClient: getPgClientMock,
  }
})

describe('native notifications API', () => {
  let executeStep = 0

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    executeStep = 0
    checkPermissionMock.mockResolvedValue(true)
    closeClientMock.mockResolvedValue(undefined)
    getPgClientMock.mockReturnValue({ id: 'pg-client' })
    getDrizzleClientMock.mockReturnValue({ execute: executeMock })
    executeMock.mockImplementation(async () => {
      executeStep += 1
      if (executeStep === 1) {
        return {
          rows: [{
            provider: 'fcm',
            status: 'configured',
            config: { projectId: 'demo-project' },
            secret_ref: 'FCM_SECRET',
          }],
        }
      }
      if (executeStep === 2) {
        return {
          rows: [{ owner_org: '00000000-0000-4000-8000-000000000001' }],
        }
      }
      return {
        rows: [{ id: 'campaign-background' }],
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('queues background send campaigns as silent background notifications', async () => {
    const { app } = await import('../supabase/functions/_backend/public/notifications/index.ts')
    const queueSend = vi.fn().mockResolvedValue(undefined)

    const response = await app.fetch(
      new Request('http://local/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: 'com.demo.app',
          name: 'Background broadcast',
          kind: 'background',
          target: { broadcast: true },
          payload: { data: { reason: 'refresh' } },
          limit: 1,
        }),
      }),
      { NOTIFICATION_QUEUE: { send: queueSend } },
      { waitUntil: () => undefined } as any,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      campaignId: 'campaign-background',
      queued: true,
    })
    expect(queueSend).toHaveBeenCalledOnce()
    expect(queueSend.mock.calls[0]?.[0]).toMatchObject({
      kind: 'send',
      appId: 'com.demo.app',
      campaignId: 'campaign-background',
      payload: {
        data: { reason: 'refresh' },
        kind: 'background',
        background: true,
        silent: true,
      },
      target: { broadcast: true },
      limit: 1,
    })
  })
})
