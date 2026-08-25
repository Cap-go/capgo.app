import { describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decryptZipInternal } from '../../src/bundle/decrypt'
import { encryptZipInternal } from '../../src/bundle/encrypt'
import { requireChecksum, requireIvSessionKey } from '../../src/bundle/validate-inputs'
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

  it('throws CliUserError when checksum format is invalid', async () => {
    await expect(encryptZipInternal('./missing.zip', 'not-a-checksum', {}, true)).rejects.toBeInstanceOf(CliUserError)
    await expect(encryptZipInternal('./missing.zip', 'not-a-checksum', {}, true)).rejects.toThrow(/checksum format/i)
  })

  it('trims leading and trailing whitespace from checksum before encryption', () => {
    const checksumWithWhitespace = '  abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  '
    expect(requireChecksum(checksumWithWhitespace)).toBe(checksumWithWhitespace.trim())
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

  it('throws CliUserError when session key is valid Base64 but not RSA ciphertext', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const iv = Buffer.alloc(16, 1).toString('base64')
    const sessionKey = Buffer.from('encrypted-session-key').toString('base64')
    const tempDir = mkdtempSync(join(tmpdir(), 'capgo-decrypt-test-'))
    const zipPath = join(tempDir, 'bundle.zip')
    const keyPath = join(tempDir, 'test.pub')
    writeFileSync(zipPath, Buffer.from('fake zip'))
    writeFileSync(keyPath, publicKeyPem)
    try {
      await expect(decryptZipInternal(zipPath, `${iv}:${sessionKey}`, { key: keyPath }, true)).rejects.toBeInstanceOf(CliUserError)
      await expect(decryptZipInternal(zipPath, `${iv}:${sessionKey}`, { key: keyPath }, true)).rejects.toThrow(/verify the ivSessionKey and public key/i)
    }
    finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
