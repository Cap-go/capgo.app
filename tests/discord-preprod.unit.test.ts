import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendDiscordAlert as sendPluginDiscordAlert } from '../supabase/functions/_backend/plugin_runtime/utils/discord.ts'
import { sendDiscordAlert } from '../supabase/functions/_backend/utils/discord.ts'

const WEBHOOK_URL = 'https://discord.test/webhook'

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
