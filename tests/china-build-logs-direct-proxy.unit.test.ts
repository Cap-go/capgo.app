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

  it('forwards WebSocket upgrade headers to the builder origin', async () => {
    fetchMock.mockImplementation((url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.capgo.app/build_logs_direct/job-ws/stream?token=tok')
      const headers = new Headers(init?.headers)
      expect(headers.get('upgrade')).toBe('websocket')
      expect(headers.get('connection')?.toLowerCase()).toContain('upgrade')
      return Promise.resolve(new Response(null, {
        status: 200,
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
      }))
    })

    const apiWorker = await loadApiWorker()
    const response = await apiWorker.fetch(new Request(
      'https://api.capgo.com.cn/build_logs_direct/job-ws/stream?token=tok',
      {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
        },
      },
    ))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
    expect(response.headers.get('upgrade')).toBe('websocket')
    expect(response.headers.get('connection')).toBe('Upgrade')
  })

  it('uses BUILDER_URL origin when configured on the worker env', async () => {
    vi.stubEnv('BUILDER_URL', 'https://builder.custom.example/jobs/')
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))

    const apiWorker = await loadApiWorker()
    await apiWorker.fetch(new Request('https://api.capgo.com.cn/build_logs_direct/job-env/snapshot'))

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://builder.custom.example/build_logs_direct/job-env/snapshot')
    vi.unstubAllEnvs()
  })

  it('does not proxy unrelated paths on the China API host', async () => {
    const apiWorker = await loadApiWorker()
    const response = await apiWorker.fetch(new Request('https://api.capgo.com.cn/ok', { method: 'POST' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' })
  })
})