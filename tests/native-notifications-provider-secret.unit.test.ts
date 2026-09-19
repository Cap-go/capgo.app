import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decryptProviderSecretWithSecretKey,
} from '../supabase/functions/_backend/utils/nativeNotifications.ts'

const textEncoder = new TextEncoder()

const DUMMY_IOS_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgdummykeymaterial
-----END PRIVATE KEY-----`

const DUMMY_ANDROID_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'firebase-adminsdk@demo-project.iam.gserviceaccount.com',
  private_key: `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n`,
})

const {
  checkPermissionMock,
  closeClientMock,
  executeMock,
  getDrizzleClientMock,
  getPgClientMock,
} = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  closeClientMock: vi.fn(),
  executeMock: vi.fn(),
  getDrizzleClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  middlewareKey: () => async (_c: unknown, next: () => Promise<void>) => next(),
  middlewareV2: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/rbac.ts')>()
  return {
    ...actual,
    checkPermission: checkPermissionMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  return {
    ...actual,
    closeClient: closeClientMock,
    getDrizzleClient: getDrizzleClientMock,
    getPgClient: getPgClientMock,
  }
})

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

async function encryptProviderSecretForTests(secretKey: string, secretMaterial: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secretKey))
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = new Uint8Array(12)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(secretMaterial))
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(encrypted))}`
}

describe('native notification provider secrets', () => {
  it.concurrent('encrypts and decrypts provider secret material', async () => {
    const secretKey = 'round-trip-secret'
    const ciphertext = await encryptProviderSecretForTests(secretKey, DUMMY_IOS_PEM)
    expect(ciphertext.startsWith('v1:')).toBe(true)
    const decrypted = await decryptProviderSecretWithSecretKey(secretKey, ciphertext)
    expect(decrypted).toBe(DUMMY_IOS_PEM)
  })

  it.concurrent('decrypts uploaded android credential material as json', async () => {
    const secretKey = 'sender-secret'
    const ciphertext = await encryptProviderSecretForTests(secretKey, DUMMY_ANDROID_JSON)
    const plaintext = await decryptProviderSecretWithSecretKey(secretKey, ciphertext)
    const parsed = JSON.parse(plaintext) as Record<string, string>
    expect(parsed.client_email).toContain('firebase-adminsdk@demo-project.iam.gserviceaccount.com')
    expect(parsed.project_id).toBe('demo-project')
  })
})

describe('native notifications provider API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    checkPermissionMock.mockResolvedValue(true)
    closeClientMock.mockResolvedValue(undefined)
    getPgClientMock.mockReturnValue({ id: 'pg-client' })
    getDrizzleClientMock.mockReturnValue({ execute: executeMock })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never returns ciphertext from GET /providers', async () => {
    executeMock.mockResolvedValue({
      rows: [{
        id: 'provider-1',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        owner_org: '00000000-0000-4000-8000-000000000001',
        app_id: 'com.demo.app',
        provider: 'apns',
        status: 'configured',
        config: { teamId: 'TEAM', keyId: 'KEY', bundleId: 'com.demo.app' },
        secret_ref: null,
        secret_ciphertext: 'v1:abc:def',
      }],
    })

    const { app } = await import('../supabase/functions/_backend/public/notifications/index.ts')
    const response = await app.fetch(
      new Request('http://local/providers?app_id=com.demo.app'),
      { NOTIFICATIONS_TOKEN_SECRET: 'api-secret' },
      { waitUntil: () => undefined } as any,
    )

    expect(response.status).toBe(200)
    const json = await response.json() as { data: Array<Record<string, unknown>> }
    expect(json.data[0]?.has_secret).toBe(true)
    expect(json.data[0]).not.toHaveProperty('secret_ciphertext')
  })
})
