import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDirectApiKeyWithBindings, fetchTestRequest, getEndpointUrl, getSupabaseClient, TEST_EMAIL, USER_ID } from './test-utils.ts'

const USE_CLOUDFLARE = process.env.USE_CLOUDFLARE_WORKERS === 'true'
const describeMcpEvents = describe.skipIf(!USE_CLOUDFLARE)

const ORG_ID = randomUUID()
const APP_ID = `com.mcp.events.${randomUUID()}`
const customerId = `cus_mcp_events_${randomUUID().replace(/-/g, '').slice(0, 20)}`

let orgApiKey: string
let appScopedKey: string
let challengeUrl: string
let challengeFailsUrl: string
let receivedHeaders: Record<string, string | undefined> = {}

function startChallengeServer() {
  return new Promise<{ url: string, failUrl: string, close: () => Promise<void> }>((resolve) => {
    let challenge: string | null = null
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        receivedHeaders = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]))
        try {
          const parsed = JSON.parse(body) as { type?: string, challenge?: string }
          if (parsed.type === 'verification') {
            challenge = parsed.challenge ?? null
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ challenge }))
            return
          }
        }
        catch {}
        res.writeHead(500)
        res.end('fail')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const base = `http://127.0.0.1:${port}/`
      resolve({
        url: `${base}ok`,
        failUrl: `${base}no-echo`,
        close: () => new Promise<void>((done, reject) => {
          server.close(err => err ? reject(err) : done())
        }),
      })
    })
  })
}

async function mcpEventsCall(apikey: string, body: unknown) {
  return fetchTestRequest(getEndpointUrl('/mcp'), {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apikey}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  if (!USE_CLOUDFLARE)
    return

  const admin = getSupabaseClient()
  await admin.from('stripe_info').insert({
    customer_id: customerId,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_${randomUUID()}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  await admin.from('orgs').insert({
    id: ORG_ID,
    name: `MCP Events Test Org ${randomUUID()}`,
    management_email: TEST_EMAIL,
    created_by: USER_ID,
    customer_id: customerId,
  })
  await admin.from('org_users').insert({ org_id: ORG_ID, user_id: USER_ID, rbac_role_name: 'org_super_admin' })
  await admin.from('apps').insert({
    app_id: APP_ID,
    name: 'MCP Events App',
    icon_url: 'https://example.com/icon.png',
    owner_org: ORG_ID,
  })

  const orgKey = await createDirectApiKeyWithBindings({
    key: randomUUID(),
    name: `mcp-events-org-${randomUUID().slice(0, 8)}`,
    orgId: ORG_ID,
    roleName: 'org_super_admin',
  })
  orgApiKey = orgKey.key ?? randomUUID()

  const appKey = await createDirectApiKeyWithBindings({
    key: randomUUID(),
    name: `mcp-events-app-${randomUUID().slice(0, 8)}`,
    orgId: ORG_ID,
    roleName: 'org_super_admin',
    appId: APP_ID,
    appRoleName: 'app_admin',
  })
  appScopedKey = appKey.key ?? randomUUID()

  process.env.CAPGO_ALLOW_LOCAL_WEBHOOK_URLS = 'true'
  const servers = await startChallengeServer()
  challengeUrl = servers.url
  challengeFailsUrl = servers.failUrl
})

afterAll(async () => {
  if (!USE_CLOUDFLARE)
    return
  delete process.env.CAPGO_ALLOW_LOCAL_WEBHOOK_URLS
})

describeMcpEvents('mcp events subscriptions', () => {
  it('lists event types from events/list and initialize capabilities', async () => {
    const init = await mcpEventsCall(orgApiKey, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } },
    })
    const initJson = await init.json() as { result: { capabilities: { events?: Record<string, boolean> } } }
    expect(initJson.result.capabilities.events).toMatchObject({ list: true, subscribe: true, unsubscribe: true })

    const list = await mcpEventsCall(orgApiKey, { jsonrpc: '2.0', id: 2, method: 'events/list' })
    const listJson = await list.json() as { result: { events: Array<{ name: string }> } }
    expect(listJson.result.events.map(event => event.name)).toEqual(
      expect.arrayContaining(['build.succeeded', 'build.failed', 'bundle.uploaded', 'bundle.deployed']),
    )
  })

  it('rejects app scoped keys', async () => {
    const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64')}`
    const response = await mcpEventsCall(appScopedKey, {
      jsonrpc: '2.0',
      id: 3,
      method: 'events/subscribe',
      params: {
        name: 'bundle.uploaded',
        arguments: { org_id: ORG_ID },
        delivery: { mode: 'webhook', url: challengeUrl, secret },
      },
    })
    expect(response.status).toBe(200)
    const json = await response.json() as { error?: { code: number } }
    expect(json.error?.code).toBe(-32024)
  })

  it('subscribes, verifies challenge headers, refreshes ttl, and unsubscribes', async () => {
    const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64')}`
    const subscribe = await mcpEventsCall(orgApiKey, {
      jsonrpc: '2.0',
      id: 4,
      method: 'events/subscribe',
      params: {
        name: 'bundle.uploaded',
        arguments: { org_id: ORG_ID, app_id: APP_ID },
        delivery: { mode: 'webhook', url: challengeUrl, secret },
        ttlMs: 60 * 60 * 1000,
      },
    })
    const subJson = await subscribe.json() as { result: { id: string, refreshBefore: string } }
    expect(subJson.result.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(receivedHeaders['x-mcp-subscription-id']).toBeTruthy()
    expect(receivedHeaders['webhook-signature']).toMatch(/^v1,/)

    const refreshed = await mcpEventsCall(orgApiKey, {
      jsonrpc: '2.0',
      id: 5,
      method: 'events/subscribe',
      params: {
        name: 'bundle.uploaded',
        arguments: { org_id: ORG_ID, app_id: APP_ID },
        delivery: { mode: 'webhook', url: challengeUrl, secret },
        ttlMs: 2 * 60 * 60 * 1000,
      },
    })
    const refreshedJson = await refreshed.json() as { result: { refreshBefore: string } }
    expect(new Date(refreshedJson.result.refreshBefore).getTime()).toBeGreaterThan(Date.now() + 30 * 60 * 1000)

    const unsub = await mcpEventsCall(orgApiKey, {
      jsonrpc: '2.0',
      id: 6,
      method: 'events/unsubscribe',
      params: { id: subJson.result.id, org_id: ORG_ID },
    })
    const unsubJson = await unsub.json() as { result: { unsubscribed: boolean } }
    expect(unsubJson.result.unsubscribed).toBe(true)
  })

  it('challenge failure keeps row but blocks verified delivery', async () => {
    const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64')}`
    const subscribe = await mcpEventsCall(orgApiKey, {
      jsonrpc: '2.0',
      id: 7,
      method: 'events/subscribe',
      params: {
        name: 'bundle.deployed',
        arguments: { org_id: ORG_ID },
        delivery: { mode: 'webhook', url: challengeFailsUrl, secret },
      },
    })
    const subJson = await subscribe.json() as { error: { code: number } }
    expect(subJson.error.code).toBe(-32027)

    const admin = getSupabaseClient()
    const { data } = await admin.from('webhooks').select('id, mcp_verified_at').eq('org_id', ORG_ID).eq('url', challengeFailsUrl)
    expect(data?.[0]?.mcp_verified_at).toBeNull()
  })

  it('enforces 25 active subscriptions per org', async () => {
    const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64')}`
    for (let i = 0; i < 25; i++) {
      await mcpEventsCall(orgApiKey, {
        jsonrpc: '2.0',
        id: 100 + i,
        method: 'events/subscribe',
        params: {
          name: 'bundle.uploaded',
          arguments: { org_id: ORG_ID },
          delivery: { mode: 'webhook', url: `${challengeUrl}?n=${i}`, secret },
        },
      })
    }
    const overflow = await mcpEventsCall(orgApiKey, {
      jsonrpc: '2.0',
      id: 200,
      method: 'events/subscribe',
      params: {
        name: 'bundle.uploaded',
        arguments: { org_id: ORG_ID },
        delivery: { mode: 'webhook', url: `${challengeUrl}?overflow=1`, secret },
      },
    })
    const overflowJson = await overflow.json() as { error: { message: string } }
    expect(overflowJson.error.message).toContain('25')
  })
})
