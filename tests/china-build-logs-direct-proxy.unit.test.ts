import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

describe('china build_logs_direct proxy on api worker', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadApiWorker() {
    return (await import('../cloudflare_workers/api/index.ts')).default
  }

  it('forwards China build_logs_direct requests to api.capgo.app with path, query, and auth', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: line\n\n'))
        controller.close()
      },
    })
    fetchMock.mockImplementation((url: string | URL, init?: RequestInit) => {
      const target = String(url)
      expect(target).toBe('https://api.capgo.app/build_logs_direct/job-1/snapshot?cursor=3')
      expect(init?.method).toBe('GET')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer jwt-test')
      expect(headers.get('x-capgo-log-token')).toBe('log-token-test')
      return Promise.resolve(new Response(stream, {
        status: 401,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      }))
    })

    const apiWorker = await loadApiWorker()
    const response = await apiWorker.fetch(new Request(
      'https://api.capgo.com.cn/build_logs_direct/job-1/snapshot?cursor=3',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer jwt-test',
          'x-capgo-log-token': 'log-token-test',
        },
      },
    ))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe('data: line\n\n')
  })

  it('does not proxy build_logs_direct on the global API host', async () => {
    const apiWorker = await loadApiWorker()
    const response = await apiWorker.fetch(new Request(
      'https://api.capgo.app/build_logs_direct/job-1/snapshot',
      { method: 'GET' },
    ))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'not_found' })
  })

  it('does not proxy unrelated paths on the China API host', async () => {
    const apiWorker = await loadApiWorker()
    const response = await apiWorker.fetch(new Request('https://api.capgo.com.cn/ok', { method: 'POST' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' })
  })
})