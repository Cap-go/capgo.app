import type { QueueApi } from '../scripts/lib/posthog-queues.ts'
import { describe, expect, it, vi } from 'vitest'
import { RETIRED_WORKERS, retireCloudflareWorkers } from '../scripts/retire-cloudflare-workers.ts'

function queueApi(existing: string[]) {
  const calls: Array<[string, string]> = []
  const api = (async (path: string, method = 'GET') => {
    calls.push([path, method])
    if (path.startsWith('?name=')) {
      const name = decodeURIComponent(path.slice('?name='.length))
      return existing.includes(name) ? [{ queue_id: `id-${name}`, queue_name: name }] : []
    }
    if (method === 'GET')
      return { queue_id: path.slice(1), queue_name: path.slice('/id-'.length) }
    return null
  }) as QueueApi
  return { api, calls }
}

describe('retireCloudflareWorkers', () => {
  it('retires the orphaned Bento dispatcher', () => {
    expect(RETIRED_WORKERS).toContainEqual({ worker: 'capgo-bento-dispatch-prod', queues: ['capgo-bento-dispatch-prod'] })
  })

  it('deletes the Worker before its queue', async () => {
    const order: string[] = []
    const scripts = vi.fn(async (name: string) => {
      order.push(`worker:${name}`)
      return 'deleted' as const
    })
    const { api, calls } = queueApi(['q1'])
    const tracked = (async (path: string, method?: string) => {
      if (method === 'DELETE')
        order.push(`queue:${path}`)
      return api(path, method)
    }) as QueueApi
    await retireCloudflareWorkers(scripts, tracked, [{ worker: 'w1', queues: ['q1'] }])
    expect(order).toEqual(['worker:w1', 'queue:/id-q1'])
    expect(calls).toContainEqual(['/id-q1', 'DELETE'])
  })

  it('is a no-op when everything is already gone', async () => {
    const scripts = vi.fn(async () => 'missing' as const)
    const { api, calls } = queueApi([])
    await retireCloudflareWorkers(scripts, api, [{ worker: 'w1', queues: ['q1'] }])
    expect(calls.some(([, method]) => method === 'DELETE')).toBe(false)
  })

  it('stops when Cloudflare rejects a Worker deletion', async () => {
    const scripts = vi.fn(async () => {
      throw new Error('rejected')
    })
    const { api, calls } = queueApi(['q1'])
    await expect(retireCloudflareWorkers(scripts, api, [{ worker: 'w1', queues: ['q1'] }])).rejects.toThrow('rejected')
    expect(calls).toEqual([])
  })
})
