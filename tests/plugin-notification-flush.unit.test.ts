import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushQueuedPluginNotifications } from '../supabase/functions/_backend/utils/plugin_notification_flush.ts'
import { PLUGIN_NOTIFICATION_QUEUE_PREFIX } from '../supabase/functions/_backend/utils/plugin_notification_queue.ts'

const deliverMock = vi.hoisted(() => vi.fn())
vi.mock('../supabase/functions/_backend/triggers/plugin_notifications.ts', () => ({
  deliverQueuedPluginNotifications: (...args: unknown[]) => deliverMock(...args),
}))

const originalApiSecret = process.env.API_SECRET
const originalCloudflareFunctionUrl = process.env.CLOUDFLARE_FUNCTION_URL

function createStore(seed: Record<string, string>) {
  const values = new Map(Object.entries(seed))
  const puts: Array<{ key: string, options?: { expirationTtl?: number }, value: string }> = []
  return {
    values,
    puts,
    async get(key: string) {
      return values.get(key) ?? null
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      puts.push({ key, value, options })
      values.set(key, value)
    },
    async delete(key: string) {
      values.delete(key)
    },
    async list({ prefix, limit }: { prefix: string, limit: number }) {
      return {
        keys: Array.from(values.keys())
          .filter(key => key.startsWith(prefix))
          .slice(0, limit)
          .map(name => ({ name })),
        list_complete: true,
      }
    },
  }
}


function createContext(env: Record<string, unknown>, inProcess = false) {
  return {
    env,
    get: (key: string) => {
      if (key === 'deliverPluginNotificationsInProcess')
        return inProcess
      return 'request-id'
    },
  } as any
}

function queueItem(eventName: string) {
  return JSON.stringify({
    type: 'org',
    eventName,
    eventData: { app_id: 'com.test.app' },
    orgId: 'org-1',
    uniqId: `uniq-${eventName}`,
    cron: '0 0 * * 1',
    managementEmail: 'owner@example.com',
    enqueuedAt: new Date().toISOString(),
  })
}

describe('plugin notification flush', () => {
  afterEach(() => {
    deliverMock.mockReset()
    vi.unstubAllGlobals()
    if (originalApiSecret === undefined)
      delete process.env.API_SECRET
    else
      process.env.API_SECRET = originalApiSecret
    if (originalCloudflareFunctionUrl === undefined)
      delete process.env.CLOUDFLARE_FUNCTION_URL
    else
      process.env.CLOUDFLARE_FUNCTION_URL = originalCloudflareFunctionUrl
  })

  it('fails when the KV queue binding is missing', async () => {
    await expect(flushQueuedPluginNotifications(createContext({}))).rejects.toThrow('Plugin notification KV queue missing')
  })

  it('deletes delivered queue items and keeps failed items for retry', async () => {
    const successKey = `${PLUGIN_NOTIFICATION_QUEUE_PREFIX}org:org-1:success:hash`
    const failedKey = `${PLUGIN_NOTIFICATION_QUEUE_PREFIX}org:org-1:failed:hash`
    const store = createStore({
      [successKey]: queueItem('success'),
      [failedKey]: queueItem('failed'),
    })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { items: Array<{ eventName: string }> }
      if (body.items[0]?.eventName === 'success')
        return new Response('{}', { status: 200 })
      return new Response('failed', { status: 500, statusText: 'failed' })
    })
    vi.stubGlobal('fetch', fetchMock)
    process.env.API_SECRET = 'secret'
    process.env.CLOUDFLARE_FUNCTION_URL = 'https://api.capgo.test'

    const result = await flushQueuedPluginNotifications(createContext({
      PLUGIN_NOTIFICATION_QUEUE: store,
    }))

    expect(result).toMatchObject({ scanned: 2, transferred: 1, deleted: 1, failed: 1 })
    expect(store.values.has(successKey)).toBe(false)
    expect(store.values.has(failedKey)).toBe(true)
    expect(Array.from(store.values.keys()).filter(key => key.startsWith('plugin:notif:processing:v1:'))).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deletes throttled queue items and writes a throttle marker', async () => {
    const throttledKey = `${PLUGIN_NOTIFICATION_QUEUE_PREFIX}org:org-1:throttled:hash`
    const store = createStore({
      [throttledKey]: queueItem('throttled'),
    })
    const lastSendAt = new Date().toISOString()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      failed: 0,
      processed: 1,
      results: [{ status: 'throttled', lastSendAt }],
      throttled: 1,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.API_SECRET = 'secret'
    process.env.CLOUDFLARE_FUNCTION_URL = 'https://api.capgo.test'

    const result = await flushQueuedPluginNotifications(createContext({
      PLUGIN_NOTIFICATION_QUEUE: store,
    }))

    expect(result).toMatchObject({ scanned: 1, transferred: 1, deleted: 1, failed: 0 })
    expect(store.values.has(throttledKey)).toBe(false)
    const throttlePut = store.puts.find(({ key }) => key.startsWith('plugin:notif:throttle:v1:'))
    expect(throttlePut?.options?.expirationTtl).toBeGreaterThanOrEqual(60)
    expect(Array.from(store.values.keys()).filter(key => key.startsWith('plugin:notif:processing:v1:'))).toEqual([])
  })

  it('delivers in-process when the scheduled flush flag is set', async () => {
    const successKey = `${PLUGIN_NOTIFICATION_QUEUE_PREFIX}org:org-1:success:hash`
    const store = createStore({
      [successKey]: queueItem('success'),
    })
    deliverMock.mockResolvedValue({
      processed: 1,
      failed: 0,
      throttled: 0,
      invalid: 0,
      results: [{ status: 'delivered' }],
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await flushQueuedPluginNotifications(createContext({
      PLUGIN_NOTIFICATION_QUEUE: store,
    }, true))

    expect(result).toMatchObject({ scanned: 1, transferred: 1, deleted: 1, failed: 0 })
    expect(store.values.has(successKey)).toBe(false)
    expect(deliverMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logs the trigger URL when HTTP transfer fails', async () => {
    const failedKey = `${PLUGIN_NOTIFICATION_QUEUE_PREFIX}org:org-1:failed:hash`
    const store = createStore({
      [failedKey]: queueItem('failed'),
    })
    const fetchMock = vi.fn(async () => new Response('error code: 522', { status: 522, statusText: '' }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.API_SECRET = 'secret'
    process.env.CLOUDFLARE_FUNCTION_URL = 'https://broken.example'

    const result = await flushQueuedPluginNotifications(createContext({
      PLUGIN_NOTIFICATION_QUEUE: store,
    }))

    expect(result).toMatchObject({ scanned: 1, transferred: 0, deleted: 0, failed: 1 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://broken.example/triggers/plugin_notifications',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
