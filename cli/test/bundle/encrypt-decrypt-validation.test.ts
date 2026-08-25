import { describe, expect, it } from 'bun:test'
import { decryptZipInternal } from '../../src/bundle/decrypt'
import { encryptZipInternal } from '../../src/bundle/encrypt'
import { requireIvSessionKey } from '../../src/bundle/validate-inputs'
import { CliUserError } from '../../src/shared/cli-user-error'
import { shouldCapturePosthogException } from '../../src/posthog'

describe('bundle encrypt input validation', () => {
  it('throws CliUserError when zip path is missing', async () => {
    await expect(encryptZipInternal(undefined as any, 'abc123', {}, true)).rejects.toBeInstanceOf(CliUserError)
    await expect(encryptZipInternal(undefined as any, 'abc123', {}, true)).rejects.toThrow(/zip path/i)
    expect(shouldCapturePosthogException(new CliUserError('Missing zip path'))).toBe(false)
  })

  it('throws CliUserError when checksum is missing', async () => {
    await expect(encryptZipInternal('./missing.zip', undefined as any, {}, true)).rejects.toBeInstanceOf(CliUserError)
    await expect(encryptZipInternal('./missing.zip', undefined as any, {}, true)).rejects.toThrow(/checksum/i)
  })
})

describe('bundle decrypt input validation', () => {
  it('throws CliUserError when zip path is missing', async () => {
    await expect(decryptZipInternal(undefined as any, 'a:b', {}, true)).rejects.toBeInstanceOf(CliUserError)
    await expect(decryptZipInternal(undefined as any, 'a:b', {}, true)).rejects.toThrow(/zip path/i)
  })

  it('throws CliUserError when ivSessionKey is missing', async () => {
    await expect(decryptZipInternal('./missing.zip', undefined as any, {}, true)).rejects.toBeInstanceOf(CliUserError)
    await expect(decryptZipInternal('./missing.zip', undefined as any, {}, true)).rejects.toThrow(/ivSessionKey/i)
    expect(shouldCapturePosthogException(new CliUserError('Missing ivSessionKey'))).toBe(false)
  })

  it('throws CliUserError when ivSessionKey is not in IV:SESSION format', async () => {
    await expect(decryptZipInternal('./missing.zip', 'checksum-only', {}, true)).rejects.toBeInstanceOf(CliUserError)
    await expect(decryptZipInternal('./missing.zip', 'checksum-only', {}, true)).rejects.toThrow(/ivSessionKey format/i)
  })

  it('throws CliUserError when ivSessionKey has invalid Base64 components', () => {
    expect(() => requireIvSessionKey('not-base64:also-not-base64')).toThrow(CliUserError)
    expect(() => requireIvSessionKey('not-base64:also-not-base64')).toThrow(/not valid Base64/i)
  })

  it('throws CliUserError when ivSessionKey has extra colon-separated segments', () => {
    expect(() => requireIvSessionKey('iv:session:extra')).toThrow(CliUserError)
    expect(() => requireIvSessionKey('iv:session:extra')).toThrow(/ivSessionKey format/i)
  })

  it('throws CliUserError when ivSessionKey IV is valid Base64 but not 16 bytes', () => {
    const shortIv = Buffer.from('short').toString('base64')
    const sessionKey = Buffer.from('encrypted-session-key').toString('base64')
    expect(() => requireIvSessionKey(`${shortIv}:${sessionKey}`)).toThrow(CliUserError)
    expect(() => requireIvSessionKey(`${shortIv}:${sessionKey}`)).toThrow(/16 bytes/i)
  })

  it('throws CliUserError when ivSessionKey IV uses non-canonical Base64 padding', () => {
    const ivWithPadding = Buffer.alloc(16, 1).toString('base64')
    const ivMissingPadding = ivWithPadding.replace(/=+$/, '')
    const sessionKey = Buffer.from('encrypted-session-key').toString('base64')
    expect(() => requireIvSessionKey(`${ivMissingPadding}:${sessionKey}`)).toThrow(CliUserError)
    expect(() => requireIvSessionKey(`${ivMissingPadding}:${sessionKey}`)).toThrow(/not valid Base64/i)
  })
})
