import { describe, expect, it } from 'vitest'
import { builderPayloadTestUtils } from '../supabase/functions/_backend/public/build/request.ts'

const { buildBuilderPayload, parseMachineVersionUnavailable } = builderPayloadTestUtils

const baseInput = {
  orgId: 'org-123',
  actorUserId: 'user-1',
  appId: 'com.test.app',
  uploadPath: 'orgs/org-123/apps/com.test/native-builds/session.zip',
  platform: 'ios',
  buildOptions: {},
  buildCredentials: {},
}

describe('builder payload shape', () => {
  it.concurrent('maps build_options (snake_case input) to buildOptions (camelCase output)', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
      buildOptions: { platform: 'ios', buildMode: 'release', cliVersion: '7.83.0' },
    })

    expect(payload).toHaveProperty('buildOptions')
    expect(payload.buildOptions).toEqual({ platform: 'ios', buildMode: 'release', cliVersion: '7.83.0' })
    // Must NOT contain the snake_case input key
    expect(payload).not.toHaveProperty('build_options')
  })

  it.concurrent('maps build_credentials (snake_case input) to buildCredentials (camelCase output)', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
      platform: 'android',
      buildCredentials: { KEYSTORE_KEY_ALIAS: 'alias', KEYSTORE_KEY_PASSWORD: 'val' },
    })

    expect(payload).toHaveProperty('buildCredentials')
    expect(payload.buildCredentials).toEqual({ KEYSTORE_KEY_ALIAS: 'alias', KEYSTORE_KEY_PASSWORD: 'val' })
    // Must NOT contain the snake_case input key
    expect(payload).not.toHaveProperty('build_credentials')
  })

  it.concurrent('does not include a legacy flat credentials field', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
      uploadPath: 'path.zip',
      buildCredentials: { SOME_SECRET: 'val' },
    })

    expect(payload).not.toHaveProperty('credentials')
  })

  it.concurrent('includes userId (org), actorUserId (human), appId, artifactKey, and fastlane with correct values', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-456',
      actorUserId: 'user-789',
      appId: 'com.example.app',
      uploadPath: 'orgs/org-456/apps/com.example/native-builds/uuid.zip',
      platform: 'android',
      buildOptions: {},
      buildCredentials: {},
    })

    expect(payload.userId).toBe('org-456')
    expect(payload.actorUserId).toBe('user-789')
    expect(payload.appId).toBe('com.example.app')
    expect(payload.artifactKey).toBe('orgs/org-456/apps/com.example/native-builds/uuid.zip')
    expect(payload.fastlane).toEqual({ lane: 'android' })
  })

  it.concurrent('contains exactly the expected top-level keys when cache is enabled (default)', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-789',
      actorUserId: 'user-1',
      appId: 'com.test.app',
      uploadPath: 'path/to/artifact.zip',
      platform: 'ios',
      buildOptions: { foo: 'bar' },
      buildCredentials: { baz: 'qux' },
    })

    const keys = Object.keys(payload).sort()
    expect(keys).toEqual([
      'actorUserId',
      'appId',
      'artifactKey',
      'buildCredentials',
      'buildOptions',
      'fastlane',
      'userId',
    ])
  })

  it.concurrent('forwards cache_key to builder payload for custom cache namespaces', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
      cacheKey: 'prod',
    })

    expect(payload.cache_key).toBe('prod')
    expect(payload.cache_fingerprint_extra).toBe('prod')

    const keys = Object.keys(payload).sort()
    expect(keys).toEqual([
      'actorUserId',
      'appId',
      'artifactKey',
      'buildCredentials',
      'buildOptions',
      'cache_fingerprint_extra',
      'cache_key',
      'fastlane',
      'userId',
    ])
  })

  it.concurrent('omits cache_key when unset', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
    })

    expect(payload).not.toHaveProperty('cache_key')
    expect(payload).not.toHaveProperty('cache_fingerprint_extra')
  })

  it.concurrent('forwards cache_enabled false when CLI opts out with --no-cache', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
      cacheEnabled: false,
    })

    expect(payload.cache_enabled).toBe(false)
    expect(payload.appId).toBe('com.test.app')

    const keys = Object.keys(payload).sort()
    expect(keys).toEqual([
      'actorUserId',
      'appId',
      'artifactKey',
      'buildCredentials',
      'buildOptions',
      'cache_enabled',
      'fastlane',
      'userId',
    ])
  })

  it.concurrent('omits cache_enabled when cache is enabled (default)', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
      cacheEnabled: true,
    })

    expect(payload).not.toHaveProperty('cache_enabled')
    expect(payload.appId).toBe('com.test.app')
  })

  it.concurrent('drops timeoutSeconds from buildOptions', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
      uploadPath: 'path/to/artifact.zip',
      buildOptions: { platform: 'ios', timeoutSeconds: 999999 },
    })

    expect(payload.buildOptions).toEqual({ platform: 'ios' })
  })

  it.concurrent('passes through buildOptions and buildCredentials contents unchanged', () => {
    const complexOptions = {
      platform: 'ios',
      buildMode: 'debug',
      cliVersion: '7.84.0',
      nested: { deep: { value: 42 } },
      array: [1, 2, 3],
    }
    const complexCredentials = {
      BUILD_CERTIFICATE_BASE64: 'base64data',
      P12_PASSWORD: 'test-val',
    }

    const payload = buildBuilderPayload({
      orgId: 'org-test',
      actorUserId: 'user-1',
      appId: 'com.complex.app',
      uploadPath: 'test/path.zip',
      platform: 'ios',
      buildOptions: complexOptions,
      buildCredentials: complexCredentials,
    })

    expect(payload.buildOptions).toEqual(complexOptions)
    expect(payload.buildCredentials).toEqual(complexCredentials)
  })
})

describe('builder machine version rejection', () => {
  it.concurrent('forwards only the builder runner_version_unavailable message', () => {
    const body = JSON.stringify({ error: 'No build machine has Xcode 27. Available: macOS 26.1 · Xcode 26.0.1.', code: 'runner_version_unavailable' })
    expect(parseMachineVersionUnavailable(400, body)).toBe('No build machine has Xcode 27. Available: macOS 26.1 · Xcode 26.0.1.')
    expect(parseMachineVersionUnavailable(500, body)).toBeNull()
    expect(parseMachineVersionUnavailable(400, JSON.stringify({ error: 'invalid payload' }))).toBeNull()
    expect(parseMachineVersionUnavailable(400, 'not json')).toBeNull()
  })

  it.concurrent('passes the requested machine versions through to the builder', () => {
    const payload = buildBuilderPayload({
      ...baseInput,
      buildOptions: { platform: 'ios', iosXcodeVersion: '26', iosMacosVersion: '26.1' },
    })
    expect(payload.buildOptions).toMatchObject({ iosXcodeVersion: '26', iosMacosVersion: '26.1' })
  })
})
