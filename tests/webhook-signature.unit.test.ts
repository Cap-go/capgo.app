import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateStandardWebhookSignature, generateWebhookSignature } from '../supabase/functions/_backend/utils/webhook.ts'

const testSecret = `whsec_${Buffer.from('12345678901234567890123456789012').toString('base64')}`
const otherSecret = `whsec_${Buffer.from('abcdefabcdefabcdefabcdefabcdef12').toString('base64')}`
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

/**
 * Verify Standard Webhooks signature using Node.js crypto (receiver-side reference implementation).
 */
function verifyStandardWebhookSignature(signature: string, secret: string, msgId: string, timestamp: string, body: string) {
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret)
  const expectedSignature = `v1,${createHmac('sha256', secretBytes).update(`${msgId}.${timestamp}.${body}`).digest('base64')}`

  return signature.split(' ').some(candidate =>
    candidate.length === expectedSignature.length
    && timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedSignature)),
  )
}

function verifyLegacyWebhookSignature(signature: string, secret: string, body: string) {
  const match = signature.match(/^v1=(\d+)\.([a-f0-9]+)$/i)
  if (!match)
    return { valid: false, timestamp: null }

  const [, timestamp, receivedHmac] = match
  const expectedHmac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  const valid = expectedHmac.length === receivedHmac.length
    && timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(receivedHmac))

  return { valid, timestamp }
}

describe('webhook signature algorithm', () => {
  it.concurrent('generates deterministic v1,{base64} HMAC-SHA256 signatures matching Node.js crypto', async () => {
    const signature = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    const expectedHmac = createHmac('sha256', Buffer.from(testSecret.slice('whsec_'.length), 'base64'))
      .update(`${messageId}.${testTimestamp}.${testPayload}`)
      .digest('base64')

    expect(signature).toMatch(/^v1,[A-Za-z0-9+/]+={0,2}$/)
    expect(signature.split(',')[1]).toBe(expectedHmac)
    expect(Buffer.from(signature.split(',')[1], 'base64')).toHaveLength(32)
    expect(await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)).toBe(signature)
  })

  it.concurrent.each([
    ['message id', [testSecret, 'different-message-id', testTimestamp, testPayload]],
    ['secret', [otherSecret, messageId, testTimestamp, testPayload]],
    ['timestamp (replay protection)', [testSecret, messageId, '1704153600', testPayload]],
    ['payload', [testSecret, messageId, testTimestamp, '{"different":"payload"}']],
  ] as const)('binds the signature to the %s', async (_label, [secret, msgId, timestamp, payload]) => {
    const base = await generateStandardWebhookSignature(testSecret, messageId, testTimestamp, testPayload)
    expect(await generateStandardWebhookSignature(secret, msgId, timestamp, payload)).not.toBe(base)
  })

  it.concurrent('produces unique signatures across many payloads', async () => {
    const signatures = new Set<string>()
    for (let i = 0; i < 100; i++)
      signatures.add(await generateStandardWebhookSignature(testSecret, 'evt_unique_payload', testTimestamp, JSON.stringify({ event: 'test', nonce: i })))

    expect(signatures.size).toBe(100)
  })

  it.concurrent('keeps generating the legacy Capgo signature format', async () => {
    const signature = await generateWebhookSignature(testSecret, testTimestamp, testPayload)
    const expectedHmac = createHmac('sha256', testSecret).update(`${testTimestamp}.${testPayload}`).digest('hex')

    expect(signature).toMatch(/^v1=\d+\.[a-f0-9]{64}$/i)
    expect(signature.split('=')[1].split('.')[1]).toBe(expectedHmac)
  })
})

describe('webhook signature verification', () => {
  const pingPayload = JSON.stringify({ type: 'test.ping', event: 'test.ping' })

  it.concurrent('verifies valid Standard Webhooks signatures', async () => {
    const signature = await generateStandardWebhookSignature(testSecret, 'evt_test_123', testTimestamp, pingPayload)
    expect(verifyStandardWebhookSignature(signature, testSecret, 'evt_test_123', testTimestamp, pingPayload)).toBe(true)
  })

  it.concurrent('rejects signatures with a wrong secret or tampered payload', async () => {
    const signature = await generateStandardWebhookSignature(testSecret, 'evt_test_123', testTimestamp, pingPayload)
    const tamperedPayload = JSON.stringify({ type: 'test.ping', event: 'test.ping', tampered: true })

    expect(verifyStandardWebhookSignature(signature, otherSecret, 'evt_test_123', testTimestamp, pingPayload)).toBe(false)
    expect(verifyStandardWebhookSignature(signature, testSecret, 'evt_test_123', testTimestamp, tamperedPayload)).toBe(false)
  })

  it.concurrent.each(['1234567890.abc123', 'invalid', ''])('rejects malformed signature %j', (signature) => {
    expect(verifyStandardWebhookSignature(signature, testSecret, 'evt_test_123', testTimestamp, pingPayload)).toBe(false)
  })

  it.concurrent('still verifies legacy Capgo signatures', async () => {
    const legacySecret = 'whsec_test_secret_key_12345'
    const signature = await generateWebhookSignature(legacySecret, testTimestamp, pingPayload)

    expect(verifyLegacyWebhookSignature(signature, legacySecret, pingPayload)).toEqual({ valid: true, timestamp: testTimestamp })
  })
})
