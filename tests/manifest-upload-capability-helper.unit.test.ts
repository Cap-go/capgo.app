import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createManifestUploadCapability,
  createManifestUploadCapabilitySigner,
  MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS,
  verifyManifestUploadCapability,
} from '../supabase/functions/_backend/utils/manifest_upload_capability.ts'

const keyId = '2026-10-a'
const secret = 'manifest-upload-capability-secret-for-unit-tests'
const replacementSecret = 'replacement-manifest-upload-secret-for-unit-tests'
const path = 'orgs/00000000-0000-0000-0000-000000000001/apps/com.example.app/delta/hash_assets%20logo.png'
const issuedAt = 1_790_956_800
const context = {} as Context
const encoder = new TextEncoder()

function base64Url(value: ArrayBuffer): string {
  return btoa(String.fromCodePoint(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function stubCapabilityEnv(overrides: Record<string, string> = {}): void {
  const values = {
    MANIFEST_UPLOAD_CAPABILITY_KEY_ID: keyId,
    MANIFEST_UPLOAD_CAPABILITY_SECRET: secret,
    MANIFEST_UPLOAD_CAPABILITY_PREVIOUS_SECRETS: '',
    ...overrides,
  }
  for (const [name, value] of Object.entries(values))
    vi.stubEnv(name, value)
}

function signingInput(overrides: Record<string, unknown> = {}) {
  return {
    expiresAt: issuedAt + MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS,
    keyId,
    manifestUploadAutoEnabled: false,
    secret,
    versionId: 12345,
    ...overrides,
  }
}

describe('manifest upload capability helper', () => {
  beforeEach(() => {
    stubCapabilityEnv()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('writes the shared prefix and validates the exact path and claims', async () => {
    const capability = await createManifestUploadCapability({
      ...signingInput(),
      path,
    }, issuedAt)

    expect(capability.tokenPrefix).toBe('v1.2026-10-a.1790957400.12345.0.')
    expect(capability.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(capability.token).toBe(`${capability.tokenPrefix}${capability.uploadToken}`)
    const canonicalPayload = [
      'capgo-manifest-upload:v1',
      keyId,
      '1790957400',
      '12345',
      '0',
      'tus-write',
      path,
    ].join('\n')
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    expect(capability.uploadToken).toBe(base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalPayload))))
    await expect(verifyManifestUploadCapability(
      context,
      capability.token,
      path,
      issuedAt + 1,
    )).resolves.toEqual({
      ok: true,
      claims: {
        expiresAt: issuedAt + MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS,
        keyId,
        manifestUploadAutoEnabled: false,
        versionId: 12345,
      },
    })
  })

  it('reuses one signer and prefix while binding each signature to one path', async () => {
    const importKeySpy = vi.spyOn(crypto.subtle, 'importKey')
    const input = signingInput()
    const signer = await createManifestUploadCapabilitySigner(input, issuedAt)
    input.keyId = 'mutated-key'
    input.expiresAt++
    input.versionId++
    input.manifestUploadAutoEnabled = true
    const first = await signer.create(path)
    const secondPath = `${path}.second`
    const second = await signer.create(secondPath)

    expect(first.tokenPrefix).toBe(signer.tokenPrefix)
    expect(second.tokenPrefix).toBe(signer.tokenPrefix)
    expect(first.uploadToken).not.toBe(second.uploadToken)
    expect(importKeySpy).toHaveBeenCalledOnce()
    importKeySpy.mockRestore()
    await expect(verifyManifestUploadCapability(context, first.token, path, issuedAt + 1))
      .resolves.toMatchObject({ ok: true })
    await expect(verifyManifestUploadCapability(context, first.token, secondPath, issuedAt + 1))
      .resolves.toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects malformed, tampered, and overlong tokens', async () => {
    const capability = await createManifestUploadCapability({ ...signingInput(), path }, issuedAt)
    const tampered = `${capability.token.slice(0, -1)}${capability.token.endsWith('A') ? 'B' : 'A'}`

    await expect(verifyManifestUploadCapability(context, 'malformed', path, issuedAt + 1))
      .resolves.toEqual({ ok: false, reason: 'invalid' })
    await expect(verifyManifestUploadCapability(context, tampered, path, issuedAt + 1))
      .resolves.toEqual({ ok: false, reason: 'invalid' })
    await expect(verifyManifestUploadCapability(context, 'v'.repeat(513), path, issuedAt + 1))
      .resolves.toEqual({ ok: false, reason: 'invalid' })
  })

  it('returns verified claims when a valid capability has expired', async () => {
    const capability = await createManifestUploadCapability({
      ...signingInput({ manifestUploadAutoEnabled: true }),
      path,
    }, issuedAt)

    await expect(verifyManifestUploadCapability(
      context,
      capability.token,
      path,
      issuedAt + MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS,
    )).resolves.toEqual({
      ok: false,
      reason: 'expired',
      claims: {
        expiresAt: issuedAt + MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS,
        keyId,
        manifestUploadAutoEnabled: true,
        versionId: 12345,
      },
    })
  })

  it('validates current and previous rotation keys without confusing unknown keys with missing configuration', async () => {
    const capability = await createManifestUploadCapability({ ...signingInput(), path }, issuedAt)
    stubCapabilityEnv({
      MANIFEST_UPLOAD_CAPABILITY_KEY_ID: '2026-10-b',
      MANIFEST_UPLOAD_CAPABILITY_SECRET: replacementSecret,
      MANIFEST_UPLOAD_CAPABILITY_PREVIOUS_SECRETS: JSON.stringify({ [keyId]: secret }),
    })

    await expect(verifyManifestUploadCapability(context, capability.token, path, issuedAt + 1))
      .resolves.toMatchObject({ ok: true })
    stubCapabilityEnv({
      MANIFEST_UPLOAD_CAPABILITY_KEY_ID: '',
      MANIFEST_UPLOAD_CAPABILITY_SECRET: '',
      MANIFEST_UPLOAD_CAPABILITY_PREVIOUS_SECRETS: '',
    })
    await expect(verifyManifestUploadCapability(context, capability.token, path, issuedAt + 1))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    stubCapabilityEnv({
      MANIFEST_UPLOAD_CAPABILITY_KEY_ID: 'unknown-key',
      MANIFEST_UPLOAD_CAPABILITY_SECRET: replacementSecret,
    })
    await expect(verifyManifestUploadCapability(context, capability.token, path, issuedAt + 1))
      .resolves.toEqual({ ok: false, reason: 'invalid' })
  })

  it('allows bounded clock skew but rejects a signed lifetime beyond the skew allowance', async () => {
    const capability = await createManifestUploadCapability({ ...signingInput(), path }, issuedAt)

    await expect(verifyManifestUploadCapability(context, capability.token, path, issuedAt - 60))
      .resolves.toMatchObject({ ok: true })
    await expect(verifyManifestUploadCapability(context, capability.token, path, issuedAt - 61))
      .resolves.toEqual({ ok: false, reason: 'invalid' })
  })

  it.each([
    { keyId: 'invalid key' },
    { secret: 'too-short' },
    { versionId: 0 },
    { expiresAt: issuedAt },
    { expiresAt: issuedAt + MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS + 1 },
  ])('refuses invalid signing input: $keyId$secret$versionId$expiresAt', async (override) => {
    await expect(createManifestUploadCapability({
      ...signingInput(override),
      path,
    }, issuedAt)).rejects.toThrow('Cannot sign invalid manifest upload capability')
  })
})
