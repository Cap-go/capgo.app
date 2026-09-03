import { describe, expect, it } from 'vitest'
import { builderPayloadTestUtils } from '../supabase/functions/_backend/public/build/request.ts'

const { buildBuilderPayload } = builderPayloadTestUtils

describe('builder payload shape', () => {
  it.concurrent('maps build_options (snake_case input) to buildOptions (camelCase output)', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-123',
      actorUserId: 'user-1',
      uploadPath: 'orgs/org-123/apps/com.test/native-builds/session.zip',
      platform: 'ios',
      buildOptions: { platform: 'ios', buildMode: 'release', cliVersion: '7.83.0' },
      buildCredentials: {},
    })

    expect(payload).toHaveProperty('buildOptions')
    expect(payload.buildOptions).toEqual({ platform: 'ios', buildMode: 'release', cliVersion: '7.83.0' })
    // Must NOT contain the snake_case input key
    expect(payload).not.toHaveProperty('build_options')
  })

  it.concurrent('maps build_credentials (snake_case input) to buildCredentials (camelCase output)', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-123',
      actorUserId: 'user-1',
      uploadPath: 'orgs/org-123/apps/com.test/native-builds/session.zip',
      platform: 'android',
      buildOptions: {},
      buildCredentials: { KEYSTORE_KEY_ALIAS: 'alias', KEYSTORE_KEY_PASSWORD: 'val' },
    })

    expect(payload).toHaveProperty('buildCredentials')
    expect(payload.buildCredentials).toEqual({ KEYSTORE_KEY_ALIAS: 'alias', KEYSTORE_KEY_PASSWORD: 'val' })
    // Must NOT contain the snake_case input key
    expect(payload).not.toHaveProperty('build_credentials')
  })

  it.concurrent('does not include a legacy flat credentials field', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-123',
      actorUserId: 'user-1',
      uploadPath: 'path.zip',
      platform: 'ios',
      buildOptions: {},
      buildCredentials: { SOME_SECRET: 'val' },
    })

    expect(payload).not.toHaveProperty('credentials')
  })

  it.concurrent('includes userId (org), actorUserId (human), artifactKey, and fastlane with correct values', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-456',
      actorUserId: 'user-789',
      uploadPath: 'orgs/org-456/apps/com.example/native-builds/uuid.zip',
      platform: 'android',
      buildOptions: {},
      buildCredentials: {},
    })

    expect(payload.userId).toBe('org-456')
    expect(payload.actorUserId).toBe('user-789')
    expect(payload.artifactKey).toBe('orgs/org-456/apps/com.example/native-builds/uuid.zip')
    expect(payload.fastlane).toEqual({ lane: 'android' })
  })

  it.concurrent('contains exactly the expected top-level keys', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-789',
      actorUserId: 'user-1',
      uploadPath: 'path/to/artifact.zip',
      platform: 'ios',
      buildOptions: { foo: 'bar' },
      buildCredentials: { baz: 'qux' },
    })

    const keys = Object.keys(payload).sort()
    expect(keys).toEqual([
      'actorUserId',
      'artifactKey',
      'buildCredentials',
      'buildOptions',
      'fastlane',
      'userId',
    ])
  })

  it.concurrent('adds dedicated pool preference when routing is active', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-dedicated',
      actorUserId: 'user-1',
      uploadPath: 'path.zip',
      platform: 'ios',
      buildOptions: {},
      buildCredentials: {},
      poolRouting: {
        preferDedicated: true,
        allowSharedFallback: true,
        poolId: 'pool-42',
        workerName: 'worker-42',
      },
    })

    expect(payload.poolPreference).toBe('dedicated')
    expect(payload.allowSharedFallback).toBe(true)
    expect(payload.poolId).toBe('pool-42')
  })

  it.concurrent('omits poolId when dedicated routing has no pool assigned yet', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-dedicated',
      actorUserId: 'user-1',
      uploadPath: 'path.zip',
      platform: 'android',
      buildOptions: {},
      buildCredentials: {},
      poolRouting: {
        preferDedicated: true,
        allowSharedFallback: false,
        poolId: null,
        workerName: null,
      },
    })

    expect(payload.poolPreference).toBe('dedicated')
    expect(payload.allowSharedFallback).toBe(false)
    expect(payload).not.toHaveProperty('poolId')
  })

  it.concurrent('drops timeoutSeconds from buildOptions', () => {
    const payload = buildBuilderPayload({
      orgId: 'org-timeout',
      actorUserId: 'user-1',
      uploadPath: 'path/to/artifact.zip',
      platform: 'ios',
      buildOptions: { platform: 'ios', timeoutSeconds: 999999 },
      buildCredentials: {},
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
      uploadPath: 'test/path.zip',
      platform: 'ios',
      buildOptions: complexOptions,
      buildCredentials: complexCredentials,
    })

    expect(payload.buildOptions).toEqual(complexOptions)
    expect(payload.buildCredentials).toEqual(complexCredentials)
  })
})
