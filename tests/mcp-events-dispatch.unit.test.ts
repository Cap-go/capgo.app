import { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchMcpEvent } from '../supabase/functions/_backend/utils/mcp_events.ts'

const ORG = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getPgClient: vi.fn(),
  urlError: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: mocks.getPgClient,
  closeClient: () => {},
  // Same contract as the real helper, on the mocked client.
  withPgTransaction: async (pg: { query: (text: string) => Promise<unknown> }, run: (client: unknown) => Promise<unknown>) => {
    await pg.query('BEGIN READ WRITE')
    try {
      const result = await run(pg)
      await pg.query('COMMIT')
      return result
    }
    catch (error) {
      await pg.query('ROLLBACK')
      throw error
    }
  },
}))
vi.mock('../supabase/functions/_backend/utils/webhook.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/webhook.ts')>(),
  getWebhookPublicUrlValidationError: mocks.urlError,
}))

function webhook(id: string, url: string, extra: Record<string, unknown> = {}) {
  return { id, org_id: ORG, url, source: 'mcp', enabled: true, mcp_verified_at: '2026-01-01T00:00:00Z', expires_at: null, mcp_event: 'bundle.uploaded', mcp_arguments: { org_id: ORG }, ...extra }
}

function setup(webhooks: ReturnType<typeof webhook>[]) {
  mocks.query.mockImplementation(async (text: string, values: unknown[]) => {
    if (text.includes('FROM public.webhooks'))
      return { rows: webhooks.map(row => ({ row })) }
    if (text.includes('INSERT INTO public.webhook_deliveries')) {
      const ids = values[0] as string[]
      return { rows: ids.map(webhookId => ({ row: { id: `delivery-${webhookId}`, webhook_id: webhookId } })) }
    }
    if (text.includes('pgmq.send_batch') || /^(?:BEGIN|COMMIT|ROLLBACK)/.test(text))
      return { rows: [] }
    throw new Error(`unexpected query: ${text}`)
  })
}

const queriesMatching = (fragment: string) => mocks.query.mock.calls.filter(([text]) => String(text).includes(fragment))

describe('dispatchMcpEvent', () => {
  const c = new Context(new Request('https://example.com/'))

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPgClient.mockResolvedValue({ query: mocks.query })
    mocks.urlError.mockResolvedValue(null)
  })

  it('inserts every delivery in one statement and queues them in one batched send', async () => {
    setup([webhook('w1', 'https://a.example.com/hook'), webhook('w2', 'https://b.example.com/hook'), webhook('w3', 'https://c.example.com/hook')])
    await dispatchMcpEvent(c, ORG, 'bundle.uploaded', { org_id: ORG, app_id: 'com.demo.app' })

    const inserts = queriesMatching('INSERT INTO public.webhook_deliveries')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1][0]).toEqual(['w1', 'w2', 'w3'])
    expect(inserts[0][1][1]).toEqual([ORG, ORG, ORG])
    expect(inserts[0][1][2]).toBe('bundle.uploaded')
    expect(inserts[0][1][4]).toBe('standard')

    const sends = queriesMatching('pgmq.send_batch')
    expect(sends).toHaveLength(1)
    expect(sends[0][1][0]).toBe('webhook_delivery')
    const messages = JSON.parse(sends[0][1][1] as string) as { function_name: string, payload: { delivery_id: string, webhook_id: string, url: string, payload: { name: string } } }[]
    expect(messages.map(message => [message.payload.delivery_id, message.payload.webhook_id, message.payload.url])).toEqual([
      ['delivery-w1', 'w1', 'https://a.example.com/hook'],
      ['delivery-w2', 'w2', 'https://b.example.com/hook'],
      ['delivery-w3', 'w3', 'https://c.example.com/hook'],
    ])
    expect(messages.every(message => message.function_name === 'webhook_delivery' && message.payload.payload.name === 'bundle.uploaded')).toBe(true)
    // One client for the webhook lookup, one for insert + send.
    expect(mocks.getPgClient).toHaveBeenCalledTimes(2)
  })

  it('checks URLs first, so a rejected URL leaves no delivery row', async () => {
    setup([webhook('w1', 'https://a.example.com/hook'), webhook('w2', 'http://10.0.0.1/hook')])
    mocks.urlError.mockImplementation(async (_c: unknown, url: string) => url.includes('10.0.0.1') ? 'private address' : null)
    await dispatchMcpEvent(c, ORG, 'bundle.uploaded', { org_id: ORG, app_id: 'com.demo.app' })

    const inserts = queriesMatching('INSERT INTO public.webhook_deliveries')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1][0]).toEqual(['w1'])
    const messages = JSON.parse(queriesMatching('pgmq.send_batch')[0][1][1] as string) as { payload: { webhook_id: string } }[]
    expect(messages.map(message => message.payload.webhook_id)).toEqual(['w1'])
  })

  it('writes nothing when every URL is rejected', async () => {
    setup([webhook('w1', 'http://10.0.0.1/hook')])
    mocks.urlError.mockResolvedValue('private address')
    await dispatchMcpEvent(c, ORG, 'bundle.uploaded', { org_id: ORG, app_id: 'com.demo.app' })
    expect(queriesMatching('INSERT INTO public.webhook_deliveries')).toHaveLength(0)
    expect(queriesMatching('pgmq.send_batch')).toHaveLength(0)
    expect(mocks.getPgClient).toHaveBeenCalledTimes(1)
  })

  it('skips webhooks whose filters do not match the event', async () => {
    setup([webhook('w1', 'https://a.example.com/hook', { mcp_arguments: { org_id: ORG, app_id: 'com.other.app' } }), webhook('w2', 'https://b.example.com/hook')])
    await dispatchMcpEvent(c, ORG, 'bundle.uploaded', { org_id: ORG, app_id: 'com.demo.app' })
    expect(queriesMatching('INSERT INTO public.webhook_deliveries')[0][1][0]).toEqual(['w2'])
    expect(mocks.urlError).toHaveBeenCalledTimes(1)
  })

  it('rolls the delivery rows back and swallows a queue failure', async () => {
    setup([webhook('w1', 'https://a.example.com/hook')])
    const base = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (text: string, values: unknown[]) => {
      if (text.includes('pgmq.send_batch'))
        throw new Error('queue down')
      return base(text, values)
    })
    await expect(dispatchMcpEvent(c, ORG, 'bundle.uploaded', { org_id: ORG, app_id: 'com.demo.app' })).resolves.toBeUndefined()
    expect(queriesMatching('INSERT INTO public.webhook_deliveries')).toHaveLength(1)
    expect(queriesMatching('ROLLBACK')).toHaveLength(1)
    expect(queriesMatching('COMMIT')).toHaveLength(0)
  })
})
