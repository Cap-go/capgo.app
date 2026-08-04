import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildNotificationBadgeStateQuery,
  buildNotificationRegistryLookupQuery,
  buildGlobalNotificationStatsQuery,
  readGlobalNotificationStatsCF,
  buildNotificationStatsQuery,
  createNotificationDeliveryEventProof,
  createNotificationEventProof,
  createNotificationIdentityProof,
  enqueueNativeNotificationFanout,
  getAllNotificationBuckets,
  getNotificationBucket,
  getNotificationDeliveryEventId,
  getNotificationEventIndex,
  getNotificationIndex,
  normalizeNotificationTag,
  shouldTrackNotificationPermissionChanged,
  trackNotificationEventCF,
  trackNotificationRegistrationCF,
  verifyNotificationDeliveryEventProof,
  verifyNotificationEventProof,
  verifyNotificationIdentityProof,
} from '../supabase/functions/_backend/utils/nativeNotifications'
import { processNativeNotificationQueueBatch, processNativeNotificationQueueMessage } from '../supabase/functions/_backend/utils/nativeNotificationSender'

const textEncoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCodePoint(byte)
  })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

async function encryptToken(secret: string, token: string) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret))
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = new Uint8Array(12)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(token))
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(encrypted))}`
}

function fcmDevice(encryptedToken: string) {
  return {
    device_key: 'device-key',
    recipient_key: 'aa-recipient',
    encrypted_token: encryptedToken,
    token_hash: 'hash',
    provider: 'fcm' as const,
    platform: 'android' as const,
    locale: '',
    timezone: '',
    app_version: '',
    plugin_version: '',
    tags: '',
    attributes: '',
    active: 1,
    badge: 0,
    permission: 2,
    consent: 1,
    updated_at: '',
  }
}

const fetchRequests = new Map<string, any[]>()
const analyticsRowsByApp = new Map<string, any[]>()

function installFetchMock() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const url = String(_url)
    if (url.includes('/analytics_engine/sql')) {
      const query = String(init?.body || '')
      const appId = query.match(/index1 IN \('([^']+):[0-9a-f]{2}'/)?.[1] ?? ''
      return new Response(JSON.stringify({ data: analyticsRowsByApp.get(appId) ?? [] }), { status: 200 })
    }

    let requestBody: any = {}
    try {
      requestBody = JSON.parse(String(init?.body || '{}'))
    }
    catch {
      requestBody = {}
    }
    const token = typeof requestBody?.message?.token === 'string' ? requestBody.message.token : ''
    if (token) {
      const requests = fetchRequests.get(token) ?? []
      requests.push(requestBody)
      fetchRequests.set(token, requests)
    }

    if (token === 'push-token-invalid')
      return new Response(JSON.stringify({ error: { status: 'UNREGISTERED', message: 'Token is gone' } }), { status: 404 })
    if (token === 'push-token-invalid-payload') {
      return new Response(JSON.stringify({
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'Invalid payload',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [{ field: 'message.notification.title' }],
          }],
        },
      }), { status: 400 })
    }
    if (token === 'push-token-transient')
      return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'Try later' } }), { status: 503 })

    return new Response(JSON.stringify({ name: 'projects/demo/messages/1' }), { status: 200 })
  })
}

function requestsFor(token: string) {
  return fetchRequests.get(token) ?? []
}

describe('native notification AE registry', () => {
  it.concurrent('uses deterministic app bucket indexes and argMax latest-device lookup', () => {
    expect(getNotificationBucket('ff00')).toBe('ff')
    expect(getNotificationBucket('not-hex')).toBe('e0')
    expect(getAllNotificationBuckets()).toHaveLength(256)
    expect(getNotificationIndex('com.demo.app', '0a')).toBe('com.demo.app:0a')

    const query = buildNotificationRegistryLookupQuery({
      dataset: 'notification_registry',
      appId: 'com.demo.app',
      buckets: ['0a'],
      recipientKey: 'recipient-key',
      now: new Date('2026-05-06T00:00:00Z'),
    })

    expect(query).toContain('FROM notification_registry')
    expect(query).toContain("index1 IN ('com.demo.app:0a')")
    expect(query).toContain('argMax(blob3, timestamp) AS encrypted_token')
    expect(query).toContain('GROUP BY blob1')
    expect(query).toContain('active = 1')
    expect(query).toContain('consent = 1')
    expect(query).toContain("recipient_key = 'recipient-key'")
  })

  it.concurrent('searches every registry bucket for device-key-only lookups', () => {
    const query = buildNotificationRegistryLookupQuery({
      dataset: 'notification_registry',
      appId: 'com.demo.app',
      deviceKey: 'device-key',
      now: new Date('2026-05-06T00:00:00Z'),
    })

    expect(query).toContain("index1 IN ('com.demo.app:00'")
    expect(query).toContain("'com.demo.app:ff'")
    expect(query).toContain("device_key = 'device-key'")
  })

  it.concurrent('builds deterministic cursor pages for queue fanout lookups', () => {
    const query = buildNotificationRegistryLookupQuery({
      dataset: 'notification_registry',
      appId: 'com.demo.app',
      buckets: ['0a'],
      deviceKeyAfter: 'device-1',
      orderByDeviceKey: true,
      limit: 51,
      now: new Date('2026-05-06T00:00:00Z'),
    })

    expect(query).toContain("blob1 > 'device-1'")
    expect(query).toContain("device_key > 'device-1'")
    expect(query).toContain('ORDER BY device_key ASC')
    expect(query).toContain('LIMIT 51')
  })

  it.concurrent('uses registration tag normalization for registry lookup filters', () => {
    const query = buildNotificationRegistryLookupQuery({
      dataset: 'notification_registry',
      appId: 'com.demo.app',
      tag: 'Beta Users',
      now: new Date('2026-05-06T00:00:00Z'),
    })

    expect(normalizeNotificationTag('Beta Users')).toBe('beta_users')
    expect(query).toContain("position('|beta_users|' IN tags) > 0")
  })

  it.concurrent('builds notification event stats from AE only', () => {
    const query = buildNotificationStatsQuery({
      dataset: 'notification_events',
      appId: 'com.demo.app',
      campaignId: 'campaign-1',
      days: 7,
      now: new Date('2026-05-06T00:00:00Z'),
    })

    expect(query).toContain('FROM notification_events')
    expect(query).toContain("index1 = 'com.demo.app:campaign-1'")
    expect(query).toContain("blob2 = 'campaign-1'")
    expect(query).toContain('COUNT(DISTINCT')
    expect(query).toContain('GROUP BY blob1')
  })

  it.concurrent('builds org notification stats query across multiple app indexes', () => {
    const query = buildNotificationStatsQuery({
      dataset: 'notification_events',
      appIds: ['com.demo.app', 'com.demo.app2'],
      days: 7,
      now: new Date('2026-05-06T00:00:00Z'),
    })

    expect(query).toContain('FROM notification_events')
    expect(query).toContain("(index1 = 'com.demo.app' OR startsWith(index1, 'com.demo.app:'))")
    expect(query).toContain("(index1 = 'com.demo.app2' OR startsWith(index1, 'com.demo.app2:'))")
    expect(query).toContain('GROUP BY blob1')
  })

  it.concurrent('rejects stats query without any app id', () => {
    expect(() => buildNotificationStatsQuery({ dataset: 'notification_events' })).toThrow()
  })

  it.concurrent('builds global notification stats query for a day window', () => {
    const query = buildGlobalNotificationStatsQuery({
      dataset: 'notification_events',
      since: new Date('2026-08-03T00:00:00Z'),
      until: new Date('2026-08-04T00:00:00Z'),
    })

    expect(query).toContain('FROM notification_events')
    expect(query).toContain("timestamp >= toDateTime('2026-08-03 00:00:00')")
    expect(query).toContain("timestamp < toDateTime('2026-08-04 00:00:00')")
    expect(query).toContain('GROUP BY blob1')
    expect(query).not.toContain('index1')
  })

  it.concurrent('throws when global notification stats require AE credentials', async () => {
    await expect(readGlobalNotificationStatsCF({
      get: () => 'test-request',
      env: {},
    } as any, {
      since: new Date('2026-08-03T00:00:00Z'),
      until: new Date('2026-08-04T00:00:00Z'),
      throwOnError: true,
    })).rejects.toThrow(/not configured/)
  })

  it.concurrent('rejects campaign stats spanning multiple apps', () => {
    expect(() => buildNotificationStatsQuery({
      dataset: 'notification_events',
      appIds: ['com.demo.app', 'com.demo.app2'],
      campaignId: 'campaign-1',
    })).toThrow()
  })

  it.concurrent('falls back to 30 days when days is not finite', () => {
    const query = buildNotificationStatsQuery({
      dataset: 'notification_events',
      appId: 'com.demo.app',
      days: Number.NaN,
      now: new Date('2026-05-06T00:00:00Z'),
    })
    expect(query).toContain("timestamp >= toDateTime('2026-04-06")
  })

  it.concurrent('builds latest desired badge lookup from AE event rows', () => {
    const query = buildNotificationBadgeStateQuery({
      dataset: 'notification_events',
      appId: 'com.demo.app',
      recipientKey: 'recipient-key',
      deviceKey: 'device-key',
      now: new Date('2026-05-06T00:00:00Z'),
    })

    expect(query).toContain('FROM notification_events')
    expect(query).toContain("blob1 = 'badge_set'")
    expect(query).toContain("blob4 = 'device-key'")
    expect(query).toContain("blob5 = 'recipient-key'")
    expect(query).toContain('argMax(double1, timestamp) AS badge')
    expect(query).toContain('argMax(double2, timestamp) AS badge_revision')
  })

  it.concurrent('tracks permission_changed only when permission state changes or old plugins omit previous state', () => {
    expect(shouldTrackNotificationPermissionChanged(undefined, 'granted')).toBe(true)
    expect(shouldTrackNotificationPermissionChanged('prompt', 'granted')).toBe(true)
    expect(shouldTrackNotificationPermissionChanged('granted', 'granted')).toBe(false)
    expect(shouldTrackNotificationPermissionChanged('denied', 'denied')).toBe(false)
  })

  it.concurrent('rejects registration when the AE registry binding is missing', async () => {
    await expect(trackNotificationRegistrationCF({
      env: {},
      get: () => 'test-request',
    } as any, {
      appId: 'com.demo.app',
      externalId: 'user-1',
      nativeInstallId: 'install-1',
      pushToken: 'push-token',
      provider: 'fcm',
      platform: 'android',
    })).rejects.toThrow('Notification registry is not configured')
  })

  it.concurrent('normalizes notification event indexes consistently for long IDs', () => {
    const appId = 'com.demo.'.concat('a'.repeat(120))
    const campaignId = 'campaign-'.concat('b'.repeat(120))
    const expectedIndex = `${appId}:${campaignId}`.slice(0, 96)
    const query = buildNotificationStatsQuery({
      dataset: 'notification_events',
      appId,
      campaignId,
      days: 7,
      now: new Date('2026-05-06T00:00:00Z'),
    })

    expect(getNotificationEventIndex(appId, campaignId)).toBe(expectedIndex)
    expect(query).toContain(`index1 = '${expectedIndex}'`)
    expect(query).toContain(`blob2 = '${campaignId}'`)
  })

  it.concurrent('keeps device events out of campaign-scoped stats', async () => {
    const rows: any[] = []
    const context = {
      env: {
        NOTIFICATION_EVENTS: {
          writeDataPoint: (row: any) => rows.push(row),
        },
      },
    } as any

    await trackNotificationEventCF(context, {
      appId: 'com.demo.app',
      event: 'permission_changed',
      campaignId: 'campaign-spoof',
      notificationId: 'notification-spoof',
      recipientKey: 'recipient-key',
      deviceKey: 'device-key',
      platform: 'android',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].indexes).toEqual(['com.demo.app'])
    expect(rows[0].blobs[1]).toBe('')
    expect(rows[0].blobs[2]).toBe('')
  })

  it.concurrent('verifies server-minted identity and event proofs', async () => {
    const previousSecret = process.env.NOTIFICATIONS_HMAC_SECRET
    process.env.NOTIFICATIONS_HMAC_SECRET = 'secret'
    try {
      const context = {} as any
      const identityProof = await createNotificationIdentityProof(context, 'com.demo.app', 'user-1')
      const eventProof = await createNotificationEventProof(context, 'com.demo.app', 'recipient-key', 'device-key')
      const deliveryProof = await createNotificationDeliveryEventProof(context, {
        appId: 'com.demo.app',
        recipientKey: 'recipient-key',
        deviceKey: 'device-key',
        campaignId: 'campaign-1',
        notificationId: 'notification-1',
        event: 'received',
      })

      expect(await verifyNotificationIdentityProof(context, 'com.demo.app', 'user-1', identityProof)).toBe(true)
      expect(await verifyNotificationIdentityProof(context, 'com.demo.app', 'user-2', identityProof)).toBe(false)
      expect(await verifyNotificationEventProof(context, 'com.demo.app', 'recipient-key', 'device-key', eventProof)).toBe(true)
      expect(await verifyNotificationEventProof(context, 'com.demo.app', 'recipient-key', 'other-device', eventProof)).toBe(false)
      expect(await verifyNotificationDeliveryEventProof(context, {
        appId: 'com.demo.app',
        recipientKey: 'recipient-key',
        deviceKey: 'device-key',
        campaignId: 'campaign-1',
        notificationId: 'notification-1',
        event: 'received',
        proof: deliveryProof,
      })).toBe(true)
      expect(await verifyNotificationDeliveryEventProof(context, {
        appId: 'com.demo.app',
        recipientKey: 'recipient-key',
        deviceKey: 'device-key',
        campaignId: 'campaign-2',
        notificationId: 'notification-1',
        event: 'received',
        proof: deliveryProof,
      })).toBe(false)
      expect(await verifyNotificationDeliveryEventProof(context, {
        appId: 'com.demo.app',
        recipientKey: 'recipient-key',
        deviceKey: 'device-key',
        campaignId: 'campaign-1',
        notificationId: 'notification-1',
        event: 'opened',
        proof: deliveryProof,
      })).toBe(false)
      expect(getNotificationDeliveryEventId({
        appId: 'com.demo.app',
        event: 'received',
        campaignId: 'campaign-1',
        notificationId: 'notification-1',
        deviceKey: 'device-key',
      })).toBe('received:com.demo.app:campaign-1:notification-1:device-key')
    }
    finally {
      if (previousSecret === undefined)
        delete process.env.NOTIFICATIONS_HMAC_SECRET
      else
        process.env.NOTIFICATIONS_HMAC_SECRET = previousSecret
    }
  })

  it.concurrent('keeps limited fanout in one queue job so the limit stays global', async () => {
    const messages: any[] = []
    const queued = await enqueueNativeNotificationFanout({
      env: {
        NOTIFICATION_QUEUE: {
          send: (message: any) => {
            messages.push(message)
            return Promise.resolve()
          },
        },
      },
    } as any, {
      kind: 'send',
      appId: 'com.demo.app',
      campaignId: 'campaign-limit',
      payload: {},
      target: { broadcast: true },
      limit: 1,
    }, ['00', '01'])

    expect(queued).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0].buckets).toEqual(['00', '01'])
    expect(messages[0].devices).toBeUndefined()
  })
})
describe('native notification queue sender', () => {
  beforeEach(() => {
    fetchRequests.clear()
    analyticsRowsByApp.clear()
    installFetchMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fetchRequests.clear()
    analyticsRowsByApp.clear()
  })

  it('resolves bucket fanout devices from AE inside the worker', async () => {
    const token = 'push-token-ae'
    const encryptedToken = await encryptToken('secret', token)
    const device = {
      ...fcmDevice(encryptedToken),
      recipient_key: 'bb-recipient',
    }
    analyticsRowsByApp.set('com.demo.ae', [device])
    const events: any[] = []

    const result = await processNativeNotificationQueueMessage({
      kind: 'send',
      appId: 'com.demo.ae',
      campaignId: 'campaign-ae',
      payload: { title: 'Hello', body: 'AE' },
      target: { recipientKey: 'bb-recipient' },
      buckets: ['bb'],
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
    }, {
      API_SECRET: 'secret',
      CF_ANALYTICS_TOKEN: 'cf-token',
      CF_ACCOUNT_ANALYTICS_ID: 'cf-account',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: (point: any) => events.push(point) },
    })

    expect(result.retryDevices).toHaveLength(0)
    expect(result.remainingDevices).toHaveLength(0)
    expect(requestsFor(token)).toHaveLength(1)
    expect(events.some(point => point.blobs[0] === 'queued')).toBe(true)
    expect(events.some(point => point.blobs[0] === 'sent')).toBe(true)
  })

  it('returns a small AE cursor continuation instead of queueing remaining device rows', async () => {
    const firstToken = 'push-token-ae-page-1'
    const secondToken = 'push-token-ae-page-2'
    const firstDevice = {
      ...fcmDevice(await encryptToken('secret', firstToken)),
      device_key: 'device-1',
    }
    const secondDevice = {
      ...fcmDevice(await encryptToken('secret', secondToken)),
      device_key: 'device-2',
    }
    analyticsRowsByApp.set('com.demo.page', [firstDevice, secondDevice])

    const result = await processNativeNotificationQueueMessage({
      kind: 'send',
      appId: 'com.demo.page',
      campaignId: 'campaign-page',
      payload: { title: 'Hello' },
      target: { broadcast: true },
      buckets: ['aa'],
      sendBatchSize: 1,
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
    }, {
      API_SECRET: 'secret',
      CF_ANALYTICS_TOKEN: 'cf-token',
      CF_ACCOUNT_ANALYTICS_ID: 'cf-account',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: () => undefined },
    })

    expect(requestsFor(firstToken)).toHaveLength(1)
    expect(requestsFor(secondToken)).toHaveLength(0)
    expect(result.remainingDevices).toHaveLength(0)
    expect(result.continuationMessage?.registryCursorDeviceKey).toBe('device-1')
    expect(result.continuationMessage?.devices).toBeUndefined()
  })

  it('builds silent update-check payloads for Capgo updater', async () => {
    const token = 'push-token-update'
    const encryptedToken = await encryptToken('secret', token)
    const result = await processNativeNotificationQueueMessage({
      kind: 'update_check',
      appId: 'com.demo.app',
      campaignId: 'campaign-update',
      payload: { silent: true, background: true, installMode: 'next', data: {} },
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
      devices: [fcmDevice(encryptedToken)],
    }, {
      API_SECRET: 'secret',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: () => undefined },
    })

    expect(result.retryDevices).toHaveLength(0)
    expect(result.remainingDevices).toHaveLength(0)
    const requests = requestsFor(token)
    expect(requests[0].message.notification).toBeUndefined()
    expect(requests[0].message.data.capgoAction).toBe('update_check')
    expect(requests[0].message.data.capgoCampaignId).toBe('campaign-update')
    expect(requests[0].message.data.capgoNotificationId).toEqual(expect.any(String))
    expect(requests[0].message.data.capgoReceivedEventProof).toEqual(expect.any(String))
    expect(requests[0].message.data.capgoOpenedEventProof).toEqual(expect.any(String))
    expect(requests[0].message.data.capgoBackgroundStartedEventProof).toEqual(expect.any(String))
    expect(requests[0].message.data.capgoBackgroundFinishedEventProof).toEqual(expect.any(String))
    expect(requests[0].message.data.capgoUpdateInstallMode).toBe('next')
    expect(requests[0].message.android.priority).toBe('high')
    expect(requests[0].message.apns.payload.aps['content-available']).toBe(1)
  })

  it('tombstones invalid FCM tokens in AE without a DB write', async () => {
    const events: any[] = []
    const registry: any[] = []

    const encryptedToken = await encryptToken('secret', 'push-token-invalid')
    const result = await processNativeNotificationQueueMessage({
      kind: 'send',
      appId: 'com.demo.app',
      campaignId: 'campaign-1',
      payload: { title: 'Hello', body: 'World' },
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
      devices: [fcmDevice(encryptedToken)],
    }, {
      API_SECRET: 'secret',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: (point: any) => events.push(point) },
      NOTIFICATION_REGISTRY: { writeDataPoint: (point: any) => registry.push(point) },
    })

    expect(result.retryDevices).toHaveLength(0)
    expect(result.remainingDevices).toHaveLength(0)
    expect(events.some(point => point.blobs[0] === 'failed')).toBe(true)
    expect(registry).toHaveLength(1)
    expect(registry[0].doubles[0]).toBe(0)
    expect(registry[0].indexes[0]).toBe('com.demo.app:aa')
  })

  it('does not tombstone non-token FCM invalid argument errors', async () => {
    const registry: any[] = []

    const encryptedToken = await encryptToken('secret', 'push-token-invalid-payload')
    const result = await processNativeNotificationQueueMessage({
      kind: 'send',
      appId: 'com.demo.app',
      campaignId: 'campaign-1',
      payload: { title: 'Hello', body: 'World' },
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
      devices: [fcmDevice(encryptedToken)],
    }, {
      API_SECRET: 'secret',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: () => undefined },
      NOTIFICATION_REGISTRY: { writeDataPoint: (point: any) => registry.push(point) },
    })

    expect(result.retryDevices).toHaveLength(0)
    expect(result.remainingDevices).toHaveLength(0)
    expect(registry).toHaveLength(0)
  })

  it('does not retry permanent or exhausted notification send failures', async () => {
    const encryptedToken = await encryptToken('wrong-secret', 'push-token-permanent')
    const permanentResult = await processNativeNotificationQueueMessage({
      kind: 'send',
      appId: 'com.demo.app',
      campaignId: 'campaign-1',
      payload: { title: 'Hello', body: 'World' },
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
      devices: [fcmDevice(encryptedToken)],
    }, {
      API_SECRET: 'secret',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: () => undefined },
    })

    const exhaustedResult = await processNativeNotificationQueueMessage({
      kind: 'send',
      appId: 'com.demo.app',
      campaignId: 'campaign-1',
      attempt: 3,
      payload: { title: 'Hello', body: 'World' },
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
      devices: [await encryptToken('secret', 'push-token-transient').then(fcmDevice)],
    }, {
      API_SECRET: 'secret',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: () => undefined },
    })

    expect(permanentResult.retryDevices).toHaveLength(0)
    expect(permanentResult.remainingDevices).toHaveLength(0)
    expect(exhaustedResult.retryDevices).toHaveLength(0)
    expect(exhaustedResult.remainingDevices).toHaveLength(0)
  })

  it('writes desired badge state before sending badge notifications', async () => {
    const events: any[] = []
    const encryptedToken = await encryptToken('secret', 'push-token-badge')
    const result = await processNativeNotificationQueueMessage({
      kind: 'badge',
      appId: 'com.demo.app',
      campaignId: 'campaign-badge',
      payload: {},
      badge: 7,
      badgeRevision: 12345,
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
      devices: [fcmDevice(encryptedToken)],
    }, {
      API_SECRET: 'secret',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: (point: any) => events.push(point) },
    })

    expect(result.retryDevices).toHaveLength(0)
    expect(events.some(point => point.blobs[0] === 'badge_set' && point.doubles[0] === 7 && point.doubles[1] === 12345)).toBe(true)
    const request = requestsFor('push-token-badge')[0]
    expect(request.message.data.capgoBadge).toBe('7')
    expect(request.message.data.capgoBadgeRevision).toBe('12345')
  })

  it('processes notification sends in bounded chunks and exposes remaining devices', async () => {
    const firstToken = 'push-token-batch-1'
    const secondToken = 'push-token-batch-2'
    const result = await processNativeNotificationQueueMessage({
      kind: 'send',
      appId: 'com.demo.app',
      campaignId: 'campaign-batch',
      payload: { title: 'Batch' },
      sendBatchSize: 1,
      providerConfigs: [{
        provider: 'fcm',
        status: 'configured',
        secretRef: 'FCM_SECRET',
        config: { projectId: 'demo-project' },
      }],
      devices: [
        fcmDevice(await encryptToken('secret', firstToken)),
        fcmDevice(await encryptToken('secret', secondToken)),
      ],
    }, {
      API_SECRET: 'secret',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: () => undefined },
    })

    expect(requestsFor(firstToken)).toHaveLength(1)
    expect(requestsFor(secondToken)).toHaveLength(0)
    expect(result.retryDevices).toHaveLength(0)
    expect(result.remainingDevices).toHaveLength(1)
  })

  it('retries the original queue message when continuation enqueue fails after sending the current page', async () => {
    const firstToken = 'push-token-continuation-1'
    const secondToken = 'push-token-continuation-2'
    const ack = vi.fn()
    const retry = vi.fn()
    const queueSend = vi.fn().mockRejectedValue(new Error('queue unavailable'))

    await processNativeNotificationQueueBatch({
      messages: [{
        body: {
          kind: 'send',
          appId: 'com.demo.app',
          campaignId: 'campaign-continuation',
          payload: { title: 'Batch' },
          sendBatchSize: 1,
          providerConfigs: [{
            provider: 'fcm',
            status: 'configured',
            secretRef: 'FCM_SECRET',
            config: { projectId: 'demo-project' },
          }],
          devices: [
            fcmDevice(await encryptToken('secret', firstToken)),
            fcmDevice(await encryptToken('secret', secondToken)),
          ],
        },
        ack,
        retry,
      }],
    } as any, {
      API_SECRET: 'secret',
      FCM_SECRET: JSON.stringify({ access_token: 'token', project_id: 'demo-project' }),
      NOTIFICATION_EVENTS: { writeDataPoint: () => undefined },
      NOTIFICATION_QUEUE: { send: queueSend },
    })

    expect(queueSend).toHaveBeenCalledTimes(1)
    expect(requestsFor(firstToken)).toHaveLength(1)
    expect(requestsFor(secondToken)).toHaveLength(0)
    expect(ack).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 })
  })
})
