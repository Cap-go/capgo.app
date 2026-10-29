import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendDiscordAlert as sendPluginDiscordAlert, sendDiscordAlert500 as sendPluginDiscordAlert500 } from '../supabase/functions/_backend/plugin_runtime/utils/discord.ts'
import { sendDiscordAlert, sendDiscordAlert500 } from '../supabase/functions/_backend/utils/discord.ts'

const WEBHOOK_URL = 'https://discord.test/webhook'

describe('assistant credential privacy in alerts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it.each([sendDiscordAlert500, sendPluginDiscordAlert500])('masks API key aliases in alert headers and JSON bodies', async (send) => {
    vi.stubEnv('DISCORD_ALERT', WEBHOOK_URL)
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const key = 'fake-api-key-for-alert-test-1234'
    const app = new Hono()
    app.get('/', async (c) => {
      await send(c, 'api', JSON.stringify({ capgkey: key, 'x-api-key': key }), new Error('failure'))
      return c.json({ status: 'ok' })
    })
    await app.request('/', { headers: { capgkey: key, 'x-api-key': key, authorization: key } })
    expect(fetchMock).toHaveBeenCalledOnce()
    const payload = String(fetchMock.mock.calls[0][1].body)
    expect(payload).not.toContain(key)
    expect(payload).toContain('fake...1234')
  })

  it('removes the entire ChatGPT token header', async () => {
    vi.stubEnv('DISCORD_ALERT', WEBHOOK_URL)
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const app = new Hono()
    app.get('/', async (c) => {
      await sendDiscordAlert500(c, 'private', '[redacted]', new Error('Upstream failure'))
      return c.json({ status: 'ok' })
    })
    await app.request('/', { headers: { 'x-chatgpt-token': 'T9x2-chatgpt-token-W8q0' } })
    expect(fetchMock).toHaveBeenCalledOnce()
    const alertBody = String(fetchMock.mock.calls[0][1].body)
    expect(alertBody).not.toContain('x-chatgpt-token')
    expect(alertBody).not.toContain('T9x2')
    expect(alertBody).not.toContain('W8q0')
  })
})

function requestAlert(send: typeof sendDiscordAlert, envName: string) {
  const app = new Hono()
  app.get('/', async (c) => {
    await send(c, { content: 'alert' })
    return c.text('ok')
  })
  // getEnv reads process.env under Node, not the request bindings.
  vi.stubEnv('DISCORD_ALERT', WEBHOOK_URL)
  vi.stubEnv('ENV_NAME', envName)
  return app.request('/')
}

describe.each([
  ['backend', sendDiscordAlert],
  ['plugin runtime', sendPluginDiscordAlert],
])('%s sendDiscordAlert', (_name, send) => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('does not post alerts from preprod workers', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await requestAlert(send, 'capgo_plugin-eu-preprod')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts alerts from prod workers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await requestAlert(send, 'capgo_plugin-eu-prod')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(WEBHOOK_URL)
  })
})
