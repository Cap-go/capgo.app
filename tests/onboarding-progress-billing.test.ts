import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDirectApiKeyWithBindings, executeSQL, fetchTestRequest, getEndpointUrl, getSupabaseClient, USER_ID } from './test-utils.ts'

const fixture = randomUUID()
const orgId = randomUUID()
const appId = `com.test.onboarding.billing.${fixture}`
const customerId = `cus_onboarding_billing_${fixture}`
const trialEndsAt = '2030-01-02T03:04:05.123Z'
const admin = getSupabaseClient()
const keys: Awaited<ReturnType<typeof createDirectApiKeyWithBindings>>[] = []
let readerKey: string

async function progress(key: string, includeBilling?: boolean, requestedAppId = appId) {
  return fetchTestRequest(getEndpointUrl('/private/onboarding_progress'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': key },
    body: JSON.stringify({ appId: requestedAppId, N: 4, includeBilling }),
  })
}

beforeAll(async () => {
  expect((await admin.from('stripe_info').insert({ customer_id: customerId, status: 'succeeded', product_id: 'prod_LQIregjtNduh4q', trial_at: trialEndsAt })).error).toBeNull()
  expect((await admin.from('orgs').insert({ id: orgId, created_by: USER_ID, name: 'Onboarding billing test', management_email: 'onboarding-billing@example.com', customer_id: customerId, has_usage_credits: true })).error).toBeNull()
  expect((await admin.from('apps').insert({ app_id: appId, owner_org: orgId, name: 'Onboarding billing test', icon_url: '' })).error).toBeNull()
  // N=4 needs no rotating observation; keep API-key login already persisted too.
  expect((await admin.from('apps').update({ onboarding: { setup: { todo_list_version: 4, ota_todo_list_version: '1', source: 'cli', steps: { ota: { login_cli_mcp: { status: 'done' } } } } } }).eq('app_id', appId)).error).toBeNull()
  for (const hashed of [false, true]) {
    keys.push(await createDirectApiKeyWithBindings({ key: randomUUID(), name: 'Onboarding billing test', orgId, hashed }))
  }
  const reader = await createDirectApiKeyWithBindings({ key: randomUUID(), name: 'Onboarding billing app reader', orgId, appId, appRoleName: 'app_reader' })
  keys.push(reader)
  await executeSQL('DELETE FROM public.role_bindings WHERE principal_type = \'apikey\' AND principal_id = $1::uuid AND scope_type = \'org\'', [reader.rbac_id])
  readerKey = reader.key!
})

afterAll(async () => {
  for (const key of keys)
    await admin.from('apikeys').delete().eq('id', key.id)
  await admin.from('apps').delete().eq('app_id', appId)
  await admin.from('orgs').delete().eq('id', orgId)
  await admin.from('stripe_info').delete().eq('customer_id', customerId)
})

describe('onboarding progress optional billing', () => {
  it.concurrent.each([0, 1])('returns the scoped summary with API-key variant %s', async (index) => {
    const response = await progress(keys[index].key!, true)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result = await response.json() as any
    expect(result.billing).toEqual({ status: 'available', orgId, orgCreatedAt: expect.any(String), trialEndsAt: expect.any(String), hasPaid: false, isPaying: true, hasCredits: true })
    expect(new Date(result.billing.trialEndsAt).toISOString()).toBe(trialEndsAt)
    expect(result.onboarding.setup.steps.ota.login_cli_mcp.status).toBe('done')
    expect(JSON.stringify(result)).not.toContain(customerId)
  })

  it.concurrent.each([undefined, false])('keeps the existing response when includeBilling=%s', async (flag) => {
    const response = await progress(keys[0].key!, flag)
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('billing')
  })

  it.concurrent('returns progress without billing to an app-only reader key', async () => {
    const response = await progress(readerKey, true)
    expect(response.status).toBe(200)
    const result = await response.json() as any
    expect(result.billing).toEqual({ status: 'unavailable' })
    expect(result.onboarding.setup.steps.ota.login_cli_mcp.status).toBe('done')
  })

  it.concurrent('does not let a scoped key inspect another app or organization', async () => {
    const response = await progress(keys[0].key!, true, `com.test.unrelated.${fixture}`)
    expect(response.status).toBe(403)
    expect(await response.json()).not.toHaveProperty('billing')
  })
})

describe('onboarding progress read permissions', () => {
  it.concurrent.each([{ N: 0, initial: false }, { N: 2, initial: false }, { N: 0, initial: true }])('serves reader observations for %j', async (poll) => {
    const response = await fetchTestRequest(getEndpointUrl('/private/onboarding_progress'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': readerKey },
      body: JSON.stringify({ appId, ...poll }),
    })
    expect(response.status).toBe(200)
    const result = await response.json() as any
    expect(result.checkErrors).toEqual([])
    expect(result.onboarding.setup.steps.ota.login_cli_mcp.status).toBe('done')
    if (poll.N === 0)
      expect(result.hasChannel).toBe(false)
  })

  it.concurrent('denies the next poll immediately after a reader binding is revoked', async () => {
    const key = await createDirectApiKeyWithBindings({ key: randomUUID(), name: 'Onboarding revocation test', orgId, appId, appRoleName: 'app_reader' })
    keys.push(key)
    await executeSQL('DELETE FROM public.role_bindings WHERE principal_type = \'apikey\' AND principal_id = $1::uuid AND scope_type = \'org\'', [key.rbac_id])
    expect((await progress(key.key!)).status).toBe(200)

    await executeSQL('DELETE FROM public.role_bindings WHERE principal_type = \'apikey\' AND principal_id = $1::uuid', [key.rbac_id])
    expect((await progress(key.key!)).status).toBe(403)
  })
})
