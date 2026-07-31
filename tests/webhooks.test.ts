import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectApiKeyWithBindings, fetchTestRequest, getAuthHeaders, getEndpointUrl, getSupabaseClient, SUPABASE_ANON_KEY, SUPABASE_BASE_URL, TEST_EMAIL, USER_ID } from './test-utils.ts'

// This file intentionally runs sequentially because it exercises one webhook
// lifecycle across create, list, update, test, delivery, and delete steps.
// Each test file still creates unique org/app fixtures, so parallel execution
// with other files remains isolated.

// Test org and webhook IDs
const WEBHOOK_TEST_ORG_ID = randomUUID()
const globalId = randomUUID()
const webhookAppId = `com.webhooks.${globalId}`
const webhookName = `Test Webhook ${globalId}`
const webhookUrl = 'https://example.com/webhook'
const customerId = `cus_test_${WEBHOOK_TEST_ORG_ID}`
const USE_CLOUDFLARE = process.env.USE_CLOUDFLARE_WORKERS === 'true'
const describeBackend = describe.skipIf(USE_CLOUDFLARE)

let createdWebhookId: string | null = null
let standardWebhookId: string | null = null
let directCreatedWebhookId: string | null = null
let reassignCreatedWebhookId: string | null = null
let reassignCreatorUserId: string | null = null
let lastDeliveryId: string | null = null
let appScopedKeyId: number | null = null
let appScopedKey: string | null = null
let orgScopedSubkeyId: number | null = null
let webhookHeaders: Record<string, string>

const webhookEndpoint = (path = '') => getEndpointUrl(`/webhooks${path}`)

function expectSanitizedUrlInfo(data: any, protocol = 'http') {
  expect(JSON.stringify(data)).not.toContain('secret-token')
  expect(data.moreInfo?.urlInfo).toMatchObject({
    valid: true,
    protocol,
    hasQuery: true,
    hasCredentials: false,
  })
}

async function getAuthenticatedAnonClient() {
  const authHeaders = await getAuthHeaders()
  return createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: authHeaders.Authorization,
      },
    },
  })
}

beforeAll(async () => {
  if (USE_CLOUDFLARE)
    return
  // Create stripe_info for this test org
  const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: customerId,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_${globalId}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  // Create test organization
  const { error } = await getSupabaseClient().from('orgs').insert({
    id: WEBHOOK_TEST_ORG_ID,
    name: `Webhook Test Org ${globalId}`,
    management_email: TEST_EMAIL,
    created_by: USER_ID,
    customer_id: customerId,
  })
  if (error)
    throw error

  const { error: memberError } = await getSupabaseClient().from('org_users').insert({
    org_id: WEBHOOK_TEST_ORG_ID,
    user_id: USER_ID,
    rbac_role_name: 'org_super_admin',
  })
  if (memberError)
    throw memberError

  const { error: appError } = await getSupabaseClient().from('apps').insert({
    app_id: webhookAppId,
    name: `Webhook Test App ${globalId}`,
    icon_url: 'https://example.com/icon.png',
    owner_org: WEBHOOK_TEST_ORG_ID,
  })
  if (appError)
    throw appError

  const appScopedKeyData = await createDirectApiKeyWithBindings({
    userId: USER_ID,
    key: randomUUID(),
    name: `webhook-app-scoped-${globalId}`,
    orgId: WEBHOOK_TEST_ORG_ID,
    roleName: 'org_member',
    appId: webhookAppId,
    appRoleName: 'app_admin',
  })
  if (!appScopedKeyData?.key) {
    throw new Error('Failed to create app-scoped API key for webhook tests')
  }

  appScopedKeyId = appScopedKeyData.id
  appScopedKey = appScopedKeyData.key

  const orgScopedSubkeyData = await createDirectApiKeyWithBindings({
    userId: USER_ID,
    key: randomUUID(),
    name: `webhook-org-scoped-subkey-${globalId}`,
    orgId: WEBHOOK_TEST_ORG_ID,
    roleName: 'org_admin',
  })
  if (!orgScopedSubkeyData?.id || !orgScopedSubkeyData?.key) {
    throw new Error('Failed to create org-scoped API subkey for webhook tests')
  }

  orgScopedSubkeyId = orgScopedSubkeyData.id
  webhookHeaders = {
    'Content-Type': 'application/json',
    'Authorization': orgScopedSubkeyData.key,
  }
})

afterAll(async () => {
  if (USE_CLOUDFLARE)
    return
  // Clean up created webhooks
  // Note: Using type assertion as webhooks table types are not yet generated
  if (createdWebhookId) {
    await (getSupabaseClient() as any).from('webhooks').delete().eq('id', createdWebhookId)
  }
  if (standardWebhookId) {
    await (getSupabaseClient() as any).from('webhooks').delete().eq('id', standardWebhookId)
  }
  if (directCreatedWebhookId) {
    await (getSupabaseClient() as any).from('webhooks').delete().eq('id', directCreatedWebhookId)
  }
  if (reassignCreatedWebhookId) {
    await (getSupabaseClient() as any).from('webhooks').delete().eq('id', reassignCreatedWebhookId)
  }
  if (reassignCreatorUserId) {
    await getSupabaseClient().from('users').delete().eq('id', reassignCreatorUserId)
    await getSupabaseClient().auth.admin.deleteUser(reassignCreatorUserId)
  }
  if (appScopedKeyId) {
    await getSupabaseClient().from('apikeys').delete().eq('id', appScopedKeyId)
  }
  if (orgScopedSubkeyId) {
    await getSupabaseClient().from('apikeys').delete().eq('id', orgScopedSubkeyId)
  }
  await getSupabaseClient().from('apps').delete().eq('app_id', webhookAppId)
  await getSupabaseClient().from('org_users').delete().eq('org_id', WEBHOOK_TEST_ORG_ID)
  // Clean up test organization and stripe_info
  await getSupabaseClient().from('orgs').delete().eq('id', WEBHOOK_TEST_ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
}, 60000)

describeBackend('[GET] /webhooks', () => {
  it('list webhooks for organization', async () => {
    const response = await fetchTestRequest(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { secret?: string }[]
    expect(Array.isArray(data)).toBe(true)
  })

  it('list webhooks with query-string pagination', async () => {
    const response = await fetchTestRequest(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}&page=0`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(200)
    const data = await response.json() as unknown[]
    expect(Array.isArray(data)).toBe(true)
  })

  it('list webhooks with missing orgId', async () => {
    const response = await fetchTestRequest(webhookEndpoint(), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_body')
  })

  it('list webhooks with invalid orgId', async () => {
    const invalidOrgId = randomUUID()
    const response = await fetchTestRequest(webhookEndpoint(`?orgId=${invalidOrgId}`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(400)
  })

  it('rejects app-scoped parent keys with org-scoped subkeys for webhook listing', async () => {
    if (!appScopedKey || !orgScopedSubkeyId)
      throw new Error('Webhook subkey list prerequisites were not created')

    const response = await fetchTestRequest(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}`), {
      headers: {
        'Content-Type': 'application/json',
        'authorization': appScopedKey,
        'x-limited-key-id': String(orgScopedSubkeyId),
      },
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string, message: string }
    expect(data.error).toBe('no_permission')
    expect(data.message).toContain('App-scoped API keys')
  })
})

describeBackend('[POST] /webhooks', () => {
  it('create webhook', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: webhookName,
        url: webhookUrl,
        events: ['app_versions'],
      }),
    })

    expect(response.status).toBe(201)
    const data = await response.json() as { status: string, webhook: { id: string, name: string, url: string, secret: string, delivery_version: string, created_by: string } }
    expect(data.status).toBe('Webhook created')
    expect(data.webhook).toBeDefined()
    expect(data.webhook.name).toBe(webhookName)
    expect(data.webhook.url).toBe(webhookUrl)
    expect(data.webhook.delivery_version).toBe('legacy')
    expect(data.webhook.secret).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/)
    expect(data.webhook.created_by).toBe(USER_ID)

    createdWebhookId = data.webhook.id
  })

  it('create webhook with Standard Webhooks delivery version', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: `Standard Webhook ${globalId}`,
        url: webhookUrl,
        events: ['app_versions'],
        deliveryVersion: 'standard',
      }),
    })

    expect(response.status).toBe(201)
    const data = await response.json() as { webhook: { id: string, delivery_version: string, secret: string } }
    expect(data.webhook.delivery_version).toBe('standard')
    expect(data.webhook.secret).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/)
    standardWebhookId = data.webhook.id
  })

  it('allows console JWT webhook listing through the API', async () => {
    const authHeaders = await getAuthHeaders()
    const response = await fetchTestRequest(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}`), {
      headers: authHeaders,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { secret?: string }[]
    expect(Array.isArray(data)).toBe(true)
    expect(data.every((webhook: { secret?: string }) => webhook.secret === undefined)).toBe(true)
  })

  it('blocks direct Supabase SDK CRUD access to webhook rows', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const directClient = await getAuthenticatedAnonClient()
    const { error: selectError } = await (directClient as any)
      .from('webhooks')
      .select('id')
      .eq('id', createdWebhookId)

    const { error: insertError } = await (directClient as any)
      .from('webhooks')
      .insert({
        org_id: WEBHOOK_TEST_ORG_ID,
        name: 'Blocked direct insert',
        url: webhookUrl,
        events: ['app_versions'],
      })

    const { error: updateError } = await (directClient as any)
      .from('webhooks')
      .update({ name: 'Blocked direct update' })
      .eq('id', createdWebhookId)

    const { error: deleteError } = await (directClient as any)
      .from('webhooks')
      .delete()
      .eq('id', createdWebhookId)

    expect(selectError?.code).toBe('42501')
    expect(insertError?.code).toBe('42501')
    expect(updateError?.code).toBe('42501')
    expect(deleteError?.code).toBe('42501')
  })

  it.concurrent('fills created_by for direct inserts that omit it', async () => {
    const webhookId = randomUUID()
    const { data, error } = await (getSupabaseClient() as any)
      .from('webhooks')
      .insert({
        id: webhookId,
        org_id: WEBHOOK_TEST_ORG_ID,
        name: `Direct Insert Webhook ${globalId}`,
        url: webhookUrl,
        events: ['app_versions'],
        enabled: true,
      })
      .select('id, created_by')
      .single()

    expect(error).toBeNull()
    expect(data?.created_by).toBe(USER_ID)

    directCreatedWebhookId = webhookId
  })

  it.concurrent('reassigns created_by when a non-owner webhook creator is deleted', async () => {
    const creatorEmail = `webhook-creator-${globalId}@capgo.test`
    const { data: authData, error: authError } = await getSupabaseClient().auth.admin.createUser({
      email: creatorEmail,
      password: 'testtest',
      email_confirm: true,
    })

    expect(authError).toBeNull()
    expect(authData.user?.id).toBeDefined()

    reassignCreatorUserId = authData.user!.id

    const { error: userError } = await getSupabaseClient().from('users').insert({
      id: reassignCreatorUserId,
      email: creatorEmail,
    })
    expect(userError).toBeNull()

    const webhookId = randomUUID()
    const { error: webhookError } = await (getSupabaseClient() as any)
      .from('webhooks')
      .insert({
        id: webhookId,
        org_id: WEBHOOK_TEST_ORG_ID,
        name: `Reassign Creator Webhook ${globalId}`,
        url: webhookUrl,
        events: ['app_versions'],
        enabled: true,
        created_by: reassignCreatorUserId,
      })

    expect(webhookError).toBeNull()
    reassignCreatedWebhookId = webhookId

    const { error: deleteError } = await getSupabaseClient()
      .from('users')
      .delete()
      .eq('id', reassignCreatorUserId)
    expect(deleteError).toBeNull()

    const { data, error } = await (getSupabaseClient() as any)
      .from('webhooks')
      .select('created_by')
      .eq('id', webhookId)
      .single()

    expect(error).toBeNull()
    expect(data?.created_by).toBe(USER_ID)

    await getSupabaseClient().auth.admin.deleteUser(reassignCreatorUserId)
    reassignCreatorUserId = null
  })

  it('create webhook with missing required fields', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: 'Missing URL Webhook',
        // Missing url and events
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_body')
  })

  it('create webhook with invalid URL', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: 'Invalid URL Webhook',
        url: 'not-a-valid-url',
        events: ['app_versions'],
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_body')
  })

  it('create webhook with HTTP URL (non-HTTPS)', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: 'HTTP URL Webhook',
        url: 'http://example.com/webhook?token=secret-token',
        events: ['app_versions'],
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string, moreInfo?: any }
    expect(data.error).toBe('invalid_url')
    expectSanitizedUrlInfo(data)
  })

  it('create webhook with invalid events', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: 'Invalid Events Webhook',
        url: webhookUrl,
        events: ['invalid_event_type'],
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_events')
  })

  it('create webhook with invalid delivery version', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: 'Invalid Version Webhook',
        url: webhookUrl,
        events: ['app_versions'],
        deliveryVersion: 'invalid',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_delivery_version')
  })

  it('create webhook with empty events array', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: 'Empty Events Webhook',
        url: webhookUrl,
        events: [],
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_body')
  })

  it('create webhook with invalid orgId', async () => {
    const invalidOrgId = randomUUID()
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: invalidOrgId,
        name: 'Invalid Org Webhook',
        url: webhookUrl,
        events: ['app_versions'],
      }),
    })
    expect(response.status).toBe(400)
  })

  it('create webhook rejects localhost URL', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: 'Localhost Webhook',
        url: 'http://localhost:3000/webhook',
        events: ['app_versions'],
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_url')
  })
})

describeBackend('[GET] /webhooks (single webhook)', () => {
  it('get single webhook by id', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetchTestRequest(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${createdWebhookId}`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { id: string, name: string, delivery_version: string, secret?: string, stats_24h: object }
    expect(data.id).toBe(createdWebhookId)
    expect(data.name).toBe(webhookName)
    expect(data.delivery_version).toBe('legacy')
    expect(data.secret).toBeUndefined()
    expect(data.stats_24h).toBeDefined()
  })

  it('get webhook with invalid webhookId', async () => {
    const invalidWebhookId = randomUUID()
    const response = await fetchTestRequest(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${invalidWebhookId}`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('webhook_not_found')
  })
})

describeBackend('[PUT] /webhooks', () => {
  it('update webhook name', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const newName = `Updated Webhook ${globalId}`
    const response = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        name: newName,
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { status: string, webhook: { name: string, secret?: string } }
    expect(data.status).toBe('Webhook updated')
    expect(data.webhook.name).toBe(newName)
    expect(data.webhook.secret).toBeUndefined()
  })

  it('update webhook URL', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const newUrl = 'https://updated.example.com/webhook'
    const response = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        url: newUrl,
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { webhook: { url: string } }
    expect(data.webhook.url).toBe(newUrl)
  })

  it('update webhook events', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        events: ['app_versions', 'channels'],
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { webhook: { events: string[] } }
    expect(data.webhook.events).toContain('app_versions')
    expect(data.webhook.events).toContain('channels')
  })

  it('update webhook enabled status', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        enabled: false,
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { webhook: { enabled: boolean } }
    expect(data.webhook.enabled).toBe(false)

    // Re-enable for subsequent tests
    await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        enabled: true,
      }),
    })
  })

  it('update webhook delivery version', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const standardResponse = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        deliveryVersion: 'standard',
      }),
    })
    expect(standardResponse.status).toBe(200)
    const standardData = await standardResponse.json() as { webhook: { delivery_version: string } }
    expect(standardData.webhook.delivery_version).toBe('standard')

    const legacyResponse = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        deliveryVersion: 'legacy',
      }),
    })
    expect(legacyResponse.status).toBe(200)
    const legacyData = await legacyResponse.json() as { webhook: { delivery_version: string } }
    expect(legacyData.webhook.delivery_version).toBe('legacy')
  })

  it('update webhook with no fields', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_updates')
  })

  it('update webhook with invalid webhookId', async () => {
    const invalidWebhookId = randomUUID()
    const response = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: invalidWebhookId,
        name: 'New Name',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('webhook_not_found')
  })

  it('update webhook with invalid events', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        events: ['invalid_event'],
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_events')
  })

  it('update webhook with HTTP URL (non-HTTPS)', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetch(webhookEndpoint(), {
      method: 'PUT',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
        url: 'http://example.com/webhook?token=secret-token',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string, moreInfo?: any }
    expect(data.error).toBe('invalid_url')
    expectSanitizedUrlInfo(data)
  })
})

describeBackend('[POST] /webhooks/test', () => {
  it('test webhook', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetch(webhookEndpoint('/test'), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
      }),
    })
    // Webhook test may fail if the URL is not reachable, but API should return 200
    expect(response.status).toBe(200)
    const data = await response.json() as { success: boolean, delivery_id: string, message: string }
    expect(typeof data.success).toBe('boolean')
    expect(data.delivery_id).toBeDefined()
    expect(data.message).toBeDefined()
    lastDeliveryId = data.delivery_id
  })

  it('stores legacy test deliveries without the Standard Webhooks type field', async () => {
    if (!lastDeliveryId)
      throw new Error('Webhook test delivery was not created')

    const { data: delivery, error } = await (getSupabaseClient() as any)
      .from('webhook_deliveries')
      .select('delivery_version, request_payload')
      .eq('id', lastDeliveryId)
      .single()

    expect(error).toBeNull()
    expect(delivery.delivery_version).toBe('legacy')
    expect(delivery.request_payload.type).toBeUndefined()
    expect(delivery.request_payload.event).toBe('test.ping')
  })

  it('test webhook with invalid webhookId', async () => {
    const invalidWebhookId = randomUUID()
    const response = await fetch(webhookEndpoint('/test'), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: invalidWebhookId,
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('webhook_not_found')
  })

  it('test webhook with invalid stored URL omits raw URL details', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const { error: updateError } = await (getSupabaseClient() as any)
      .from('webhooks')
      .update({ url: 'http://example.com/webhook-test?token=secret-token' })
      .eq('id', createdWebhookId)
    expect(updateError).toBeNull()

    try {
      const response = await fetch(webhookEndpoint('/test'), {
        method: 'POST',
        headers: webhookHeaders,
        body: JSON.stringify({
          orgId: WEBHOOK_TEST_ORG_ID,
          webhookId: createdWebhookId,
        }),
      })
      expect(response.status).toBe(400)
      const data = await response.json() as { error: string, moreInfo?: any }
      expect(data.error).toBe('invalid_url')
      expectSanitizedUrlInfo(data)
    }
    finally {
      await (getSupabaseClient() as any)
        .from('webhooks')
        .update({ url: webhookUrl })
        .eq('id', createdWebhookId)
    }
  })

  it('test webhook with missing body', async () => {
    const response = await fetch(webhookEndpoint('/test'), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    // Empty body {} returns 'invalid_json_parse_body' since getBodyOrQuery checks for empty objects
    expect(data.error).toBe('invalid_json_parse_body')
  })

  it('rejects app-scoped API keys for org-scoped webhook tests', async () => {
    if (!createdWebhookId || !appScopedKey)
      throw new Error('Webhook test prerequisites were not created')

    const response = await fetch(webhookEndpoint('/test'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': appScopedKey,
      },
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string, message: string }
    expect(data.error).toBe('no_permission')
    expect(data.message).toContain('App-scoped API keys')
  })

  it('rejects app-scoped parent keys with org-scoped subkeys for webhook tests', async () => {
    if (!createdWebhookId || !appScopedKey || !orgScopedSubkeyId)
      throw new Error('Webhook subkey test prerequisites were not created')

    const response = await fetch(webhookEndpoint('/test'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': appScopedKey,
        'x-limited-key-id': String(orgScopedSubkeyId),
      },
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string, message: string }
    expect(data.error).toBe('no_permission')
    expect(data.message).toContain('App-scoped API keys')
  })
})

describeBackend('[GET] /webhooks/deliveries', () => {
  it('get webhook deliveries', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetchTestRequest(webhookEndpoint(`/deliveries?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${createdWebhookId}`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { deliveries: any[], pagination: { page: number, per_page: number, total: number, has_more: boolean } }
    expect(Array.isArray(data.deliveries)).toBe(true)
    expect(data.pagination).toBeDefined()
    expect(data.pagination.page).toBe(0)
    expect(data.pagination.per_page).toBe(50)
  })

  it('allows console JWT delivery listing through the API', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const authHeaders = await getAuthHeaders()
    const response = await fetchTestRequest(webhookEndpoint(`/deliveries?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${createdWebhookId}`), {
      headers: authHeaders,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { deliveries: any[] }
    expect(Array.isArray(data.deliveries)).toBe(true)
  })

  it('blocks direct Supabase SDK access to webhook delivery rows', async () => {
    if (!lastDeliveryId)
      throw new Error('Webhook delivery was not created in previous test')

    const directClient = await getAuthenticatedAnonClient()
    const { error } = await (directClient as any)
      .from('webhook_deliveries')
      .select('id')
      .eq('id', lastDeliveryId)

    expect(error?.code).toBe('42501')
  })

  it('get webhook deliveries with status filter', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetchTestRequest(webhookEndpoint(`/deliveries?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${createdWebhookId}&status=success`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { deliveries: any[] }
    expect(Array.isArray(data.deliveries)).toBe(true)
  })

  it('get webhook deliveries with pagination', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetchTestRequest(webhookEndpoint(`/deliveries?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${createdWebhookId}&page=0`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { pagination: { page: number } }
    expect(data.pagination.page).toBe(0)
  })

  it('get webhook deliveries with invalid webhookId', async () => {
    const invalidWebhookId = randomUUID()
    const response = await fetchTestRequest(webhookEndpoint(`/deliveries?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${invalidWebhookId}`), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('webhook_not_found')
  })

  it('get webhook deliveries with missing body', async () => {
    const response = await fetchTestRequest(webhookEndpoint('/deliveries'), {
      headers: webhookHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_body')
  })
})

describeBackend('[POST] /webhooks/deliveries/retry', () => {
  it('retry delivery with invalid deliveryId', async () => {
    const invalidDeliveryId = randomUUID()
    const response = await fetch(webhookEndpoint('/deliveries/retry'), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        deliveryId: invalidDeliveryId,
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('delivery_not_found')
  })

  it('rejects app-scoped API keys for org-scoped delivery retries', async () => {
    if (!lastDeliveryId || !appScopedKey)
      throw new Error('Delivery retry prerequisites were not created')

    const response = await fetch(webhookEndpoint('/deliveries/retry'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': appScopedKey,
      },
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        deliveryId: lastDeliveryId,
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string, message: string }
    expect(data.error).toBe('no_permission')
    expect(data.message).toContain('App-scoped API keys')
  })

  it('rejects app-scoped parent keys with org-scoped subkeys for delivery retries', async () => {
    if (!lastDeliveryId || !appScopedKey || !orgScopedSubkeyId)
      throw new Error('Delivery retry subkey prerequisites were not created')

    const response = await fetch(webhookEndpoint('/deliveries/retry'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': appScopedKey,
        'x-limited-key-id': String(orgScopedSubkeyId),
      },
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        deliveryId: lastDeliveryId,
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string, message: string }
    expect(data.error).toBe('no_permission')
    expect(data.message).toContain('App-scoped API keys')
  })

  it('rejects retrying pending deliveries', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const pendingDeliveryId = randomUUID()
    const { error: insertError } = await (getSupabaseClient() as any)
      .from('webhook_deliveries')
      .insert({
        id: pendingDeliveryId,
        webhook_id: createdWebhookId,
        org_id: WEBHOOK_TEST_ORG_ID,
        event_type: 'app_versions.INSERT',
        request_payload: {
          event: 'app_versions.INSERT',
          event_id: randomUUID(),
          timestamp: new Date().toISOString(),
          org_id: WEBHOOK_TEST_ORG_ID,
          data: {
            table: 'app_versions',
            operation: 'INSERT',
            record_id: randomUUID(),
            old_record: null,
            new_record: null,
            changed_fields: null,
          },
        },
        delivery_version: 'legacy',
        status: 'pending',
      })
    expect(insertError).toBeNull()

    try {
      const response = await fetch(webhookEndpoint('/deliveries/retry'), {
        method: 'POST',
        headers: webhookHeaders,
        body: JSON.stringify({
          orgId: WEBHOOK_TEST_ORG_ID,
          deliveryId: pendingDeliveryId,
        }),
      })
      expect(response.status).toBe(400)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('delivery_not_failed')
    }
    finally {
      await (getSupabaseClient() as any)
        .from('webhook_deliveries')
        .delete()
        .eq('id', pendingDeliveryId)
    }
  })

  it('retry delivery with invalid webhook URL omits raw URL details', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const failedDeliveryId = randomUUID()
    const { error: insertError } = await (getSupabaseClient() as any)
      .from('webhook_deliveries')
      .insert({
        id: failedDeliveryId,
        webhook_id: createdWebhookId,
        org_id: WEBHOOK_TEST_ORG_ID,
        event_type: 'app_versions.INSERT',
        request_payload: {
          event: 'app_versions.INSERT',
          event_id: randomUUID(),
          timestamp: new Date().toISOString(),
          org_id: WEBHOOK_TEST_ORG_ID,
          data: {
            table: 'app_versions',
            operation: 'INSERT',
            record_id: randomUUID(),
            old_record: null,
            new_record: null,
            changed_fields: null,
          },
        },
        delivery_version: 'legacy',
        status: 'failed',
        response_status: 500,
        response_body: 'failed test delivery',
        attempt_count: 1,
      })
    expect(insertError).toBeNull()

    const { error: updateError } = await (getSupabaseClient() as any)
      .from('webhooks')
      .update({ url: 'http://example.com/retry-webhook?token=secret-token' })
      .eq('id', createdWebhookId)
    expect(updateError).toBeNull()

    try {
      const response = await fetch(webhookEndpoint('/deliveries/retry'), {
        method: 'POST',
        headers: webhookHeaders,
        body: JSON.stringify({
          orgId: WEBHOOK_TEST_ORG_ID,
          deliveryId: failedDeliveryId,
        }),
      })
      expect(response.status).toBe(400)
      const data = await response.json() as { error: string, moreInfo?: any }
      expect(data.error).toBe('invalid_url')
      expectSanitizedUrlInfo(data)
    }
    finally {
      await (getSupabaseClient() as any)
        .from('webhooks')
        .update({ url: webhookUrl })
        .eq('id', createdWebhookId)
      await (getSupabaseClient() as any)
        .from('webhook_deliveries')
        .delete()
        .eq('id', failedDeliveryId)
    }
  })

  it('retry delivery with missing body', async () => {
    const response = await fetch(webhookEndpoint('/deliveries/retry'), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    // Empty body {} returns 'invalid_json_parse_body' since getBodyOrQuery checks for empty objects
    expect(data.error).toBe('invalid_json_parse_body')
  })
})

describeBackend('[DELETE] /webhooks', () => {
  it('delete webhook with invalid webhookId', async () => {
    const invalidWebhookId = randomUUID()
    const response = await fetch(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${invalidWebhookId}`), {
      method: 'DELETE',
      headers: webhookHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('webhook_not_found')
  })

  it('delete webhook with missing body', async () => {
    const response = await fetch(webhookEndpoint(), {
      method: 'DELETE',
      headers: webhookHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    // No body in request returns 'invalid_json_parse_body' since getBodyOrQuery checks for empty body
    expect(data.error).toBe('invalid_json_parse_body')
  })

  it('delete webhook', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in previous test')

    const response = await fetch(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${createdWebhookId}`), {
      method: 'DELETE',
      headers: webhookHeaders,
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { status: string, webhookId: string }
    expect(data.status).toBe('Webhook deleted')
    expect(data.webhookId).toBe(createdWebhookId)

    // Verify deletion
    const getResponse = await fetch(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${createdWebhookId}`), {
      headers: webhookHeaders,
    })
    expect(getResponse.status).toBe(400)

    createdWebhookId = null // Reset for cleanup
  })

  it('delete already deleted webhook', async () => {
    // Create a new webhook to delete
    const createResponse = await fetch(webhookEndpoint(), {
      method: 'POST',
      headers: webhookHeaders,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: 'Webhook to double delete',
        url: webhookUrl,
        events: ['app_versions'],
      }),
    })
    const createData = await createResponse.json() as { webhook: { id: string } }
    const webhookId = createData.webhook.id

    // First deletion
    await fetch(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${webhookId}`), {
      method: 'DELETE',
      headers: webhookHeaders,
    })

    // Second deletion attempt
    const response = await fetch(webhookEndpoint(`?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${webhookId}`), {
      method: 'DELETE',
      headers: webhookHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('webhook_not_found')
  })
})
