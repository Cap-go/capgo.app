import { Buffer } from 'node:buffer'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateStandardWebhookSignature, generateWebhookSignature } from '../supabase/functions/_backend/utils/webhook.ts'
import { BASE_URL, createDirectApiKeyWithBindings, getSupabaseClient, TEST_EMAIL, USER_ID } from './test-utils.ts'

// Test data
const WEBHOOK_TEST_ORG_ID = randomUUID()
const globalId = randomUUID()
const customerId = `cus_test_${WEBHOOK_TEST_ORG_ID}`
const webhookApiKey = randomUUID()
let createdWebhookId: string | null = null
let createdDeliveryId: string | null = null
let webhookSecret: string | null = null
let headers: Record<string, string>
let webhookApiKeyId: number | null = null

interface WebhookDelivery {
  id: string
  event_type: string
  request_payload: {
    type?: string
    event?: string
    org_id?: string
    event_id?: string
    timestamp?: string
    data?: unknown
  }
}

async function getCreatedDelivery(): Promise<WebhookDelivery> {
  const webhookId = createdWebhookId
  const deliveryId = createdDeliveryId
  if (!webhookId || !deliveryId)
    throw new Error('Webhook delivery was not created')

  const response = await fetch(`${BASE_URL}/webhooks/deliveries?orgId=${WEBHOOK_TEST_ORG_ID}&webhookId=${webhookId}`, { headers })
  const data = await response.json() as { deliveries: WebhookDelivery[] }
  expect(response.status, JSON.stringify(data)).toBe(200)

  const delivery = data.deliveries.find(delivery => delivery.id === deliveryId)
  if (!delivery)
    throw new Error(`Delivery ${deliveryId} was not returned by the deliveries API`)

  return delivery
}

/**
 * Verify Standard Webhooks signature using Node.js crypto.
 */
function verifyStandardWebhookSignature(
  signature: string,
  secret: string,
  messageId: string,
  timestamp: string,
  body: string,
): { valid: boolean, error?: string } {
  const signatures = signature.split(' ')
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret)
  const signaturePayload = `${messageId}.${timestamp}.${body}`
  const expectedSignature = `v1,${createHmac('sha256', secretBytes)
    .update(signaturePayload)
    .digest('base64')}`

  const valid = signatures.some(candidate =>
    candidate.length === expectedSignature.length
    && timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedSignature)),
  )

  return valid ? { valid: true } : { valid: false, error: 'HMAC verification failed' }
}

function verifyLegacyWebhookSignature(
  signature: string,
  secret: string,
  body: string,
): { valid: boolean, timestamp: string | null, error?: string } {
  const match = signature.match(/^v1=(\d+)\.([a-f0-9]+)$/i)
  if (!match)
    return { valid: false, timestamp: null, error: 'Invalid signature format' }

  const [, timestamp, receivedHmac] = match
  const expectedHmac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')

  const valid = expectedHmac.length === receivedHmac.length
    && timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(receivedHmac))

  return valid ? { valid: true, timestamp } : { valid: false, timestamp, error: 'HMAC verification failed' }
}

beforeAll(async () => {
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
    name: `Webhook Signature Test Org ${globalId}`,
    management_email: TEST_EMAIL,
    created_by: USER_ID,
    customer_id: customerId,
  })
  if (error)
    throw error

  const apiKey = await createDirectApiKeyWithBindings({
    key: webhookApiKey,
    name: `webhook-signature-${globalId}`,
    orgId: WEBHOOK_TEST_ORG_ID,
    roleName: 'org_admin',
  })
  if (!apiKey.key)
    throw new Error('Failed to create webhook API key')

  webhookApiKeyId = apiKey.id
  headers = {
    'Content-Type': 'application/json',
    'Authorization': apiKey.key,
  }
})

afterAll(async () => {
  // Clean up webhook deliveries first (foreign key constraint)
  if (createdWebhookId) {
    await (getSupabaseClient() as any).from('webhook_deliveries').delete().eq('webhook_id', createdWebhookId)
    await (getSupabaseClient() as any).from('webhooks').delete().eq('id', createdWebhookId)
  }
  // Clean up test organization and stripe_info
  if (webhookApiKeyId !== null)
    await getSupabaseClient().from('apikeys').delete().eq('id', webhookApiKeyId).throwOnError()
  await getSupabaseClient().from('orgs').delete().eq('id', WEBHOOK_TEST_ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
})

describe('webhook signature algorithm', () => {
  const testSecret = `whsec_${Buffer.from('12345678901234567890123456789012').toString('base64')}`
  const messageId = '123e4567-e89b-12d3-a456-426614174000'
  const testTimestamp = '1704067200'
  const testPayload = JSON.stringify({
    type: 'app_versions.INSERT',
    event: 'app_versions.INSERT',
    event_id: messageId,
    timestamp: '2024-01-01T00:00:00.000Z',
    org_id: 'org-123',
    data: {
      table: 'app_versions',
      operation: 'INSERT',
      record_id: 'version-123',
      old_record: null,
      new_record: { id: 'version-123', name: '1.0.0' },
      changed_fields: null,
    },
  })

  it('should generate Standard Webhooks signature format v1,{base64}', async () => {
    const signature = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    expect(signature).toMatch(/^v1,[A-Za-z0-9+/]+={0,2}$/)
  })

  it('should produce consistent Standard Webhooks signatures for same inputs', async () => {
    const sig1 = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const sig2 = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    expect(sig1).toBe(sig2)
  })

  it('should produce different Standard Webhooks signatures for different message ids', async () => {
    const sig1 = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const sig2 = await generateStandardWebhookSignature(testSecret, 'different-message-id', testTimestamp, testPayload)
    expect(sig1).not.toBe(sig2)
  })

  it('should produce different Standard Webhooks signatures for different secrets', async () => {
    const sig1 = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const sig2 = await generateStandardWebhookSignature(`whsec_${Buffer.from('abcdefabcdefabcdefabcdefabcdef12').toString('base64')}`, messageId, testTimestamp, testPayload)
    expect(sig1).not.toBe(sig2)
  })

  it('should produce different Standard Webhooks signatures for different timestamps', async () => {
    const sig1 = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const sig2 = await generateStandardWebhookSignature(testSecret, messageId, '1704153600', testPayload)
    expect(sig1).not.toBe(sig2)
  })

  it('should produce different Standard Webhooks signatures for different payloads', async () => {
    const sig1 = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const sig2 = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, '{"different":"payload"}')
    expect(sig1).not.toBe(sig2)
  })

  it('should match Node.js crypto Standard Webhooks HMAC generation', async () => {
    const signature = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const [, hmac] = signature.split(',')
    const expectedHmac = createHmac('sha256', Buffer.from(testSecret.slice('whsec_'.length), 'base64'))
      .update(`${messageId}.${testTimestamp}.${testPayload}`)
      .digest('base64')

    expect(hmac).toBe(expectedHmac)
  })

  it('should keep generating the legacy Capgo signature format', async () => {
    const signature = await generateWebhookSignature(testSecret, testTimestamp, testPayload)
    const [, timestampAndHmac] = signature.split('=')
    const [, hmac] = timestampAndHmac.split('.')
    const expectedHmac = createHmac('sha256', testSecret)
      .update(`${testTimestamp}.${testPayload}`)
      .digest('hex')

    expect(signature).toMatch(/^v1=\d+\.[a-f0-9]{64}$/i)
    expect(hmac).toBe(expectedHmac)
  })
})

describe('webhook signature verification', () => {
  const testSecret = `whsec_${Buffer.from('12345678901234567890123456789012').toString('base64')}`
  const messageId = 'evt_test_123'
  const testTimestamp = '1704067200'
  const testPayload = JSON.stringify({ type: 'test.ping', event: 'test.ping' })

  it('should verify valid Standard Webhooks signature', async () => {
    const signature = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const result = verifyStandardWebhookSignature(signature, testSecret, messageId, testTimestamp, testPayload)

    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('should reject Standard Webhooks signature with wrong secret', async () => {
    const signature = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const result = verifyStandardWebhookSignature(
      signature,
      `whsec_${Buffer.from('abcdefabcdefabcdefabcdefabcdef12').toString('base64')}`,
      messageId,
      testTimestamp,
      testPayload,
    )

    expect(result.valid).toBe(false)
    expect(result.error).toBe('HMAC verification failed')
  })

  it('should reject Standard Webhooks signature with tampered payload', async () => {
    const signature = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const tamperedPayload = JSON.stringify({ type: 'test.ping', event: 'test.ping', tampered: true })
    const result = verifyStandardWebhookSignature(signature, testSecret, messageId, testTimestamp, tamperedPayload)

    expect(result.valid).toBe(false)
    expect(result.error).toBe('HMAC verification failed')
  })

  it('should still verify legacy Capgo signatures', async () => {
    const legacySecret = 'whsec_test_secret_key_12345'
    const signature = await generateWebhookSignature(legacySecret, testTimestamp, testPayload)
    const result = verifyLegacyWebhookSignature(signature, legacySecret, testPayload)

    expect(result.valid).toBe(true)
    expect(result.timestamp).toBe(testTimestamp)
  })

  it('should reject malformed Standard Webhooks signatures', () => {
    expect(verifyStandardWebhookSignature('1234567890.abc123', testSecret, messageId, testTimestamp, testPayload).valid).toBe(false)

    expect(verifyStandardWebhookSignature('invalid', testSecret, messageId, testTimestamp, testPayload).valid).toBe(false)

    expect(verifyStandardWebhookSignature('', testSecret, messageId, testTimestamp, testPayload).valid).toBe(false)
  })
})

describe('webhook creation and secret generation', () => {
  it('should create webhook with auto-generated secret', async () => {
    // Using a valid HTTPS URL since localhost is rejected in non-local environments
    const webhookUrl = 'https://example.com/webhook-test'

    const response = await fetch(`${BASE_URL}/webhooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: `Signature Test Webhook ${globalId}`,
        url: webhookUrl,
        events: ['app_versions'],
        deliveryVersion: 'standard',
      }),
    })

    expect(response.status).toBe(201)
    const data = await response.json() as { status: string, webhook: { id: string } }
    expect(data.status).toBe('Webhook created')

    createdWebhookId = data.webhook.id
  })

  it('should store a secret for the webhook', async () => {
    expect(createdWebhookId).not.toBeNull()

    const { data: webhook, error } = await (getSupabaseClient() as any)
      .from('webhooks')
      .select('secret')
      .eq('id', createdWebhookId)
      .single()

    expect(error).toBeNull()
    expect(webhook).not.toBeNull()
    expect(webhook.secret).toBeDefined()
    expect(typeof webhook.secret).toBe('string')
    expect(webhook.secret).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/)
    expect(Buffer.from(webhook.secret.slice('whsec_'.length), 'base64')).toHaveLength(32)

    webhookSecret = webhook.secret
  })

  it('should generate unique secrets for different webhooks', async () => {
    // Create another webhook
    const response = await fetch(`${BASE_URL}/webhooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        name: `Another Signature Test Webhook ${globalId}`,
        url: 'https://example.com/webhook-test-2',
        events: ['app_versions'],
      }),
    })

    expect(response.status).toBe(201)
    const data = await response.json() as { webhook: { id: string } }
    const anotherWebhookId = data.webhook.id

    // Get the secret
    const { data: webhook } = await (getSupabaseClient() as any)
      .from('webhooks')
      .select('secret')
      .eq('id', anotherWebhookId)
      .single()

    expect(webhook.secret).not.toBe(webhookSecret)

    // Clean up
    await (getSupabaseClient() as any).from('webhooks').delete().eq('id', anotherWebhookId)
  })

  it('should be able to verify a Standard Webhooks signature with the stored secret', async () => {
    expect(webhookSecret).not.toBeNull()

    const timestamp = Math.floor(Date.now() / 1000).toString()
    const messageId = randomUUID()
    const payload = JSON.stringify({
      type: 'test.ping',
      event: 'test.ping',
      event_id: messageId,
      org_id: WEBHOOK_TEST_ORG_ID,
    })

    // Generate signature with the real secret
    const signature = await generateStandardWebhookSignature(webhookSecret!, messageId, timestamp, payload)

    // Verify it can be validated
    const result = verifyStandardWebhookSignature(signature, webhookSecret!, messageId, timestamp, payload)

    expect(result.valid).toBe(true)
  })
})

describe('webhook delivery record creation', () => {
  it('should create delivery record when triggering test webhook', async () => {
    expect(createdWebhookId).not.toBeNull()

    // Trigger the test webhook (it will fail to deliver since URL is example.com, but record should be created)
    const response = await fetch(`${BASE_URL}/webhooks/test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        orgId: WEBHOOK_TEST_ORG_ID,
        webhookId: createdWebhookId,
      }),
    })

    const data = await response.json() as { delivery_id: string, success: boolean }
    expect(response.status, JSON.stringify(data)).toBe(200)
    expect(data.delivery_id).toBeDefined()
    // The delivery will fail since example.com won't accept our webhook
    createdDeliveryId = data.delivery_id
    expect(data.success).toBe(false)
  })

  it('should store the payload in delivery record', async () => {
    const delivery = await getCreatedDelivery()

    expect(delivery.request_payload).toBeDefined()
    expect(delivery.request_payload.type).toBe('test.ping')
    expect(delivery.request_payload.event).toBe('test.ping')
    expect(delivery.request_payload.org_id).toBe(WEBHOOK_TEST_ORG_ID)
    expect(delivery.request_payload.event_id).toBeDefined()
    expect(delivery.request_payload.timestamp).toBeDefined()
    expect(delivery.request_payload.data).toBeDefined()
  })

  it('should record the event type correctly', async () => {
    const delivery = await getCreatedDelivery()

    expect(delivery.event_type).toBe('test.ping')
  })
})

describe('signature security properties', () => {
  it('should use HMAC-SHA256 producing 256-bit signatures', async () => {
    const secret = `whsec_${Buffer.from('12345678901234567890123456789012').toString('base64')}`
    const signature = await generateStandardWebhookSignature(secret, 'evt_123', '12345', '{}')
    const hmac = signature.split(',')[1]

    // 256 bits = 32 bytes = 44 base64 characters with padding
    expect(Buffer.from(hmac, 'base64')).toHaveLength(32)
  })

  it('should include timestamp to prevent replay attacks', async () => {
    const secret = `whsec_${Buffer.from('12345678901234567890123456789012').toString('base64')}`
    const messageId = 'evt_replay_test'
    const payload = '{}'

    const oldTimestamp = '1609459200' // 2021-01-01
    const newTimestamp = '1704067200' // 2024-01-01

    const oldSig = await generateStandardWebhookSignature(secret, messageId, oldTimestamp, payload)
    const newSig = await generateStandardWebhookSignature(secret, messageId, newTimestamp, payload)

    // Different timestamps = different signatures
    expect(oldSig).not.toBe(newSig)
  })

  it('should include message id to bind signatures to idempotency keys', async () => {
    const secret = `whsec_${Buffer.from('12345678901234567890123456789012').toString('base64')}`
    const timestamp = '1704067200'
    const payload = '{}'

    const firstSig = await generateStandardWebhookSignature(secret, 'evt_1', timestamp, payload)
    const secondSig = await generateStandardWebhookSignature(secret, 'evt_2', timestamp, payload)

    expect(firstSig).not.toBe(secondSig)
  })

  it('should produce unique signatures for different payloads', async () => {
    const secret = `whsec_${Buffer.from('12345678901234567890123456789012').toString('base64')}`
    const messageId = 'evt_unique_payload'
    const timestamp = '1704067200'
    const signatures = new Set<string>()

    for (let i = 0; i < 100; i++) {
      const payload = JSON.stringify({ event: 'test', nonce: i })
      const sig = await generateStandardWebhookSignature(secret, messageId, timestamp, payload)
      signatures.add(sig)
    }

    // All 100 signatures should be unique
    expect(signatures.size).toBe(100)
  })
})
