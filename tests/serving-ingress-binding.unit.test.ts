import { Hono } from 'hono'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin from '../cloudflare_workers/plugin/index.ts'
import { enforceServingPolicy } from '../supabase/functions/_backend/plugin_runtime/utils/servingPolicy.ts'

const rollout = vi.hoisted((): { epoch: string | null } => ({ epoch: 'staging-test-epoch' }))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js', () => ({ get servingRegionReaderEpoch() { return rollout.epoch } }))

const appId = 'com.example.ingress-binding'
const secret = 'local-ingress-binding-test-secret-32-characters'
const sharedAddress = '2a06:98c0:3600::103'
const sharedAddresses = [
  sharedAddress,
  '2A06:98C0:3600::103',
  '2a06:98c0:3600::0103',
  '2a06:98c0:3600:0::103',
  '2a06:98c0:3600:0000:0000:0000:0000:0103',
]

function request(path: string, colo: string, ip: string, receipt?: string) {
  const headers = new Headers({ 'cf-connecting-ip': ip })
  if (receipt)
    headers.set('x-capgo-serving-ingress', receipt)
  const req = new Request('https://plugin.eu.capgo.app' + path, { headers })
  Object.defineProperty(req, 'cf', { value: { colo } })
  return req
}

function harness() {
  const dataAccess = vi.fn()
  const get = vi.fn(async () => ({ json: async () => ({ f: 1, app_id: appId, generation: '1', policy: { regions: ['NA'], mode: 'block' } }) }))
  const app = new Hono()
  app.get('/', async (c) => {
    await enforceServingPolicy(c, appId)
    dataAccess()
    return c.json({ status: 'ok' })
  })
  const env = {
    ENV_NAME: 'capgo_plugin-eu-prod',
    SERVING_REGION_SIGNING_KEY: secret,
    PLUGIN_STATE_POINTERS: { get },
  }
  return { app, env, get, dataAccess }
}

async function signedReceipt(ip: string) {
  const payload = JSON.stringify({ appId, region: 'NA', ip, expires: Date.now() + 1000 })
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const signature = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
  return `${encodeURIComponent(payload)}.${signature}`
}

beforeEach(() => { rollout.epoch = 'staging-test-epoch' })
afterEach(() => { vi.restoreAllMocks() })

describe('serving ingress receipt bindings', () => {
  it.each(sharedAddresses)('does not issue a receipt for nonunique address %s', async (ip) => {
    const { env } = harness()
    const response = await plugin.fetch(request('/serving_policy/' + appId, 'IAD', ip), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'serving_policy_unavailable' })
  })

  it.each(sharedAddresses)('rejects an already signed nonunique binding %s before app data', async (ip) => {
    const { app, env, dataAccess } = harness()
    const receipt = await signedReceipt(ip)
    const response = await app.fetch(request('/', 'CDG', ip, receipt), env)
    expect(response.status).toBe(503)
    expect(dataAccess).not.toHaveBeenCalled()
  })

  it.each(['192.0.2.7', '2001:db8::7'])('keeps unique address %s receipts valid across regional routing', async (ip) => {
    const { app, env, dataAccess } = harness()
    const issued = await plugin.fetch(request('/serving_policy/' + appId, 'IAD', ip), env)
    expect(issued.status).toBe(200)
    const body: unknown = await issued.json()
    assert(body && typeof body === 'object' && 'receipt' in body && typeof body.receipt === 'string')
    expect((await app.fetch(request('/', 'CDG', ip, body.receipt), env)).status).toBe(200)
    expect(dataAccess).toHaveBeenCalledOnce()
  })

  it('keeps direct requests without receipts bound to their own ingress', async () => {
    const { app, env, dataAccess } = harness()
    expect((await app.fetch(request('/', 'CDG', sharedAddress), env)).status).toBe(403)
    expect((await app.fetch(request('/', 'IAD', sharedAddress), env)).status).toBe(200)
    expect(dataAccess).toHaveBeenCalledOnce()
  })

  it('keeps the disabled gateway free of policy reads and receipt requirements', async () => {
    rollout.epoch = null
    const { env, get } = harness()
    const response = await plugin.fetch(request('/serving_policy/' + appId, 'IAD', sharedAddress), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ app_id: appId, active: false, phase: 'disabled' })
    expect(get).not.toHaveBeenCalled()
  })
})
