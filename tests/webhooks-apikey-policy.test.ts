import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDirectApiKeyWithBindings, getEndpointUrl, getSupabaseClient, USER_ID_2 } from './test-utils.ts'

const globalId = randomUUID()
const policyOrgId = randomUUID()
const policySecondaryOrgId = randomUUID()
const policyCustomerId = `cus_webhook_policy_${globalId}`
const policySecondaryCustomerId = `cus_webhook_policy_secondary_${globalId}`
const WEBHOOKS_URL = getEndpointUrl('/webhooks')
const WEBHOOKS_TEST_URL = getEndpointUrl('/webhooks/test')
const WEBHOOKS_RETRY_URL = getEndpointUrl('/webhooks/deliveries/retry')
const seededWebhookId = randomUUID()
const seededDeliveryId = randomUUID()

let primaryApiKeyId: number | null = null
let primaryApiKeyValue: string | null = null
let expiringSubkeyId: number | null = null
let expiringSubkeyValue: string | null = null
let delegatedApiKeyId: number | null = null
let delegatedApiKeyValue: string | null = null
let createdWebhookId: string | null = null
let createdDeliveryId: string | null = null
let policyOwnerUserId: string | null = null

beforeAll(async () => {
  const supabase = getSupabaseClient()
  const policyOwnerEmail = `webhook-policy-owner-${globalId}@capgo.test`

  const { data: policyOwnerAuth, error: policyOwnerAuthError } = await supabase.auth.admin.createUser({
    email: policyOwnerEmail,
    password: 'testtest',
    email_confirm: true,
  })
  if (policyOwnerAuthError || !policyOwnerAuth.user) {
    throw policyOwnerAuthError ?? new Error('Failed to create webhook policy owner auth user')
  }
  policyOwnerUserId = policyOwnerAuth.user.id

  const { error: policyOwnerUserError } = await supabase.from('users').insert({
    id: policyOwnerUserId,
    email: policyOwnerEmail,
  })
  if (policyOwnerUserError)
    throw policyOwnerUserError

  const { error: stripeError } = await supabase.from('stripe_info').insert({
    customer_id: policyCustomerId,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_webhook_policy_${globalId}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  const { error: orgError } = await supabase.from('orgs').insert({
    id: policyOrgId,
    name: `Webhook Policy Org ${globalId}`,
    management_email: policyOwnerEmail,
    created_by: policyOwnerUserId,
    customer_id: policyCustomerId,
  })
  if (orgError)
    throw orgError

  const { error: memberError } = await supabase.from('org_users').insert({
    org_id: policyOrgId,
    user_id: policyOwnerUserId,
    rbac_role_name: 'org_super_admin',
  })
  if (memberError)
    throw memberError

  const { error: secondaryStripeError } = await supabase.from('stripe_info').insert({
    customer_id: policySecondaryCustomerId,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_webhook_policy_secondary_${globalId}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (secondaryStripeError)
    throw secondaryStripeError

  const { error: secondaryOrgError } = await supabase.from('orgs').insert({
    id: policySecondaryOrgId,
    name: `Webhook Policy Secondary Org ${globalId}`,
    management_email: policyOwnerEmail,
    created_by: policyOwnerUserId,
    customer_id: policySecondaryCustomerId,
  })
  if (secondaryOrgError)
    throw secondaryOrgError

  const { error: secondaryMemberError } = await supabase.from('org_users').insert({
    org_id: policySecondaryOrgId,
    user_id: policyOwnerUserId,
    rbac_role_name: 'org_super_admin',
  })
  if (secondaryMemberError)
    throw secondaryMemberError

  const primaryKeyData = await createDirectApiKeyWithBindings({
    userId: policyOwnerUserId,
    key: `webhook-primary-key-${globalId}`,
    name: `webhook-primary-key-${globalId}`,
    orgId: policyOrgId,
    roleName: 'org_admin',
  })
  if (!primaryKeyData.key)
    throw new Error('Failed to seed webhook API key')
  primaryApiKeyId = primaryKeyData.id
  primaryApiKeyValue = primaryKeyData.key

  // Seed preconditions directly so policy tests do not depend on webhook delivery side effects.
  const { error: webhookError } = await (supabase as any).from('webhooks').insert({
    id: seededWebhookId,
    org_id: policyOrgId,
    name: `policy-webhook-${globalId}`,
    url: 'https://example.com/webhook-policy',
    events: ['orgs'],
    enabled: true,
    created_by: policyOwnerUserId,
  })
  if (webhookError)
    throw webhookError
  createdWebhookId = seededWebhookId

  const { error: deliveryError } = await (supabase as any).from('webhook_deliveries').insert({
    id: seededDeliveryId,
    webhook_id: seededWebhookId,
    org_id: policyOrgId,
    event_type: 'orgs.TEST',
    status: 'failed',
    request_payload: {
      event_id: seededDeliveryId,
      event_type: 'orgs.TEST',
      org_id: policyOrgId,
      data: { test: true },
    },
    response_status: 500,
    response_body: 'seeded test delivery',
    attempt_count: 1,
    max_attempts: 3,
  })
  if (deliveryError)
    throw deliveryError
  createdDeliveryId = seededDeliveryId

  const { error: policyError } = await supabase.from('orgs').update({
    require_apikey_expiration: true,
    max_apikey_expiration_days: 30,
  }).eq('id', policyOrgId)
  if (policyError)
    throw policyError

  const expiringKeyData = await createDirectApiKeyWithBindings({
    userId: policyOwnerUserId,
    key: `expiring-webhook-subkey-${globalId}`,
    name: `expiring-webhook-subkey-${globalId}`,
    orgId: policyOrgId,
    roleName: 'org_admin',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  if (!expiringKeyData.key)
    throw new Error('Failed to seed expiring webhook API key')
  expiringSubkeyId = expiringKeyData.id
  expiringSubkeyValue = expiringKeyData.key

  const delegatedKeyData = await createDirectApiKeyWithBindings({
    userId: USER_ID_2,
    key: `delegated-webhook-key-${globalId}`,
    name: `delegated-webhook-key-${globalId}`,
    orgId: policyOrgId,
    roleName: 'org_admin',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  if (!delegatedKeyData.key)
    throw new Error('Failed to seed delegated webhook API key')
  delegatedApiKeyId = delegatedKeyData.id
  delegatedApiKeyValue = delegatedKeyData.key
}, 60000)

afterAll(async () => {
  const supabase = getSupabaseClient()

  if (createdWebhookId) {
    await (supabase as any).from('webhooks').delete().eq('id', createdWebhookId)
  }

  if (primaryApiKeyId) {
    await supabase.from('apikeys').delete().eq('id', primaryApiKeyId)
  }

  if (expiringSubkeyId) {
    await supabase.from('apikeys').delete().eq('id', expiringSubkeyId)
  }

  if (delegatedApiKeyId) {
    await supabase.from('apikeys').delete().eq('id', delegatedApiKeyId)
  }

  await supabase.from('role_bindings').delete().eq('org_id', policyOrgId)
  await supabase.from('role_bindings').delete().eq('org_id', policySecondaryOrgId)
  await supabase.from('org_users').delete().eq('org_id', policyOrgId)
  await supabase.from('org_users').delete().eq('org_id', policySecondaryOrgId)
  await supabase.from('orgs').delete().eq('id', policyOrgId)
  await supabase.from('orgs').delete().eq('id', policySecondaryOrgId)
  await supabase.from('stripe_info').delete().eq('customer_id', policyCustomerId)
  await supabase.from('stripe_info').delete().eq('customer_id', policySecondaryCustomerId)
  if (policyOwnerUserId) {
    await supabase.from('users').delete().eq('id', policyOwnerUserId)
    await supabase.auth.admin.deleteUser(policyOwnerUserId)
  }
}, 60000)

describe('webhook endpoints enforce org API key expiration policy', () => {
  it('rejects webhook listing for org non-expiring org key', async () => {
    if (!primaryApiKeyValue)
      throw new Error('Legacy API key was not created')

    const response = await fetch(`${WEBHOOKS_URL}?orgId=${policyOrgId}`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': primaryApiKeyValue,
      },
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('org_requires_expiring_key')
  })

  it('rejects webhook creation for org non-expiring org key', async () => {
    if (!primaryApiKeyValue)
      throw new Error('Legacy API key was not created')

    const response = await fetch(WEBHOOKS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': primaryApiKeyValue,
      },
      body: JSON.stringify({
        orgId: policyOrgId,
        name: `blocked-webhook-${globalId}`,
        url: 'https://example.com/blocked-webhook',
        events: ['orgs'],
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('org_requires_expiring_key')
  })

  it('rejects webhook deletion for org non-expiring org key', async () => {
    if (!primaryApiKeyValue || !createdWebhookId)
      throw new Error('Webhook deletion prerequisites were not created')

    const response = await fetch(WEBHOOKS_URL, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': primaryApiKeyValue,
      },
      body: JSON.stringify({
        orgId: policyOrgId,
        webhookId: createdWebhookId,
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('org_requires_expiring_key')
  })

  it('rejects webhook test for org non-expiring org key', async () => {
    if (!primaryApiKeyValue || !createdWebhookId)
      throw new Error('Webhook test prerequisites were not created')

    const response = await fetch(WEBHOOKS_TEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': primaryApiKeyValue,
      },
      body: JSON.stringify({
        orgId: policyOrgId,
        webhookId: createdWebhookId,
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('org_requires_expiring_key')
  })

  it('rejects delivery retry for org non-expiring org key', async () => {
    if (!primaryApiKeyValue || !createdDeliveryId)
      throw new Error('Webhook delivery prerequisites were not created')

    const response = await fetch(WEBHOOKS_RETRY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': primaryApiKeyValue,
      },
      body: JSON.stringify({
        orgId: policyOrgId,
        deliveryId: createdDeliveryId,
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('org_requires_expiring_key')
  })

  it('rejects webhook test when an org parent key attaches an expiring subkey', async () => {
    if (!primaryApiKeyValue || !expiringSubkeyId || !createdWebhookId)
      throw new Error('Webhook subkey policy prerequisites were not created')

    const response = await fetch(WEBHOOKS_TEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': primaryApiKeyValue,
        'x-limited-key-id': String(expiringSubkeyId),
      },
      body: JSON.stringify({
        orgId: policyOrgId,
        webhookId: createdWebhookId,
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('org_requires_expiring_key')
  })

  it('allows webhook listing for a compliant expiring org key', async () => {
    if (!expiringSubkeyValue)
      throw new Error('Expiring API key was not created')

    const response = await fetch(`${WEBHOOKS_URL}?orgId=${policyOrgId}`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': expiringSubkeyValue,
      },
    })

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
  })

  it('allows delivery retry for a delegated API key with org_admin RBAC', async () => {
    if (!delegatedApiKeyValue || !createdDeliveryId)
      throw new Error('Delegated webhook retry prerequisites were not created')

    const response = await fetch(WEBHOOKS_RETRY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': delegatedApiKeyValue,
      },
      body: JSON.stringify({
        orgId: policyOrgId,
        deliveryId: createdDeliveryId,
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { deliveryId: string, status: string }
    expect(data.deliveryId).toBe(createdDeliveryId)
    expect(data.status).toBe('Delivery queued for retry')
  })
})
