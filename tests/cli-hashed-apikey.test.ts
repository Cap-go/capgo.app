/**
 * Tests for CLI operations using hashed (encrypted) API keys
 *
 * These tests verify that CLI operations work correctly when using hashed API keys
 * instead of plain-text API keys. The hashed key is stored as SHA-256 hash in the
 * database, but the client sends the plain key value which gets hashed server-side
 * for comparison.
 *
 * IMPORTANT: Uses isolated RLS test data (ORG_ID_RLS, USER_ID_RLS) to prevent
 * interference with other tests that may modify shared org/stripe data.
 */
import type { UploadOptions } from '@capgo/cli/sdk'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestSDK } from './cli-sdk-utils'
import { cleanupCli, getSemver, prepareCli, tempFileFolder } from './cli-utils'
import { CLI_HASHED_APIKEY, CLI_HASHED_ORG_ID, CLI_HASHED_STRIPE_CUSTOMER_ID, CLI_HASHED_USER_ID, resetAndSeedAppData, resetAppData, resetAppDataStats } from './test-utils'

/**
 * Create an SDK instance with the CLI hashed API key (isolated test data)
 */
function createHashedKeySDK() {
  return createTestSDK(CLI_HASHED_APIKEY)
}

/**
 * Upload a bundle using the hashed API key
 */
async function uploadBundleWithHashedKey(
  appId: string,
  version: string,
  channel?: string,
  additionalOptions?: Partial<UploadOptions>,
) {
  const sdk = createHashedKeySDK()

  const options: UploadOptions = {
    appId,
    path: join(tempFileFolder(appId), 'dist'),
    bundle: version,
    channel,
    disableCodeCheck: true,
    useZip: true,
    ...additionalOptions,
  }

  return sdk.uploadBundle(options)
}

describe('cli operations with hashed API key', () => {
  const id = randomUUID()
  const APPNAME = `com.cli_hashed_${id}`

  beforeAll(async () => {
    await Promise.all([
      resetAndSeedAppData(APPNAME, { orgId: CLI_HASHED_ORG_ID, userId: CLI_HASHED_USER_ID, stripeCustomerId: CLI_HASHED_STRIPE_CUSTOMER_ID }),
      prepareCli(APPNAME),
    ])
  })

  afterAll(async () => {
    await Promise.all([
      cleanupCli(APPNAME),
      resetAppData(APPNAME),
      resetAppDataStats(APPNAME),
    ])
  })

  it('should upload bundle successfully with hashed API key', async () => {
    const semver = getSemver()
    const result = await uploadBundleWithHashedKey(APPNAME, semver, 'production', {
      ignoreCompatibilityCheck: true,
    })

    expect(result.success).toBe(true)
  }, 30000)

  it('should list bundles with hashed API key', async () => {
    const sdk = createHashedKeySDK()
    const result = await sdk.listBundles(APPNAME)

    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
  }, 30000)

  it('should list channels with hashed API key', async () => {
    const sdk = createHashedKeySDK()
    const result = await sdk.listChannels(APPNAME)

    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
  }, 30000)

  it('should list apps with hashed API key', async () => {
    const sdk = createHashedKeySDK()
    const result = await sdk.listApps()

    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
    // Verify our test app is in the list
    const hasTestApp = result.data?.some((app: any) => app.appId === APPNAME)
    expect(hasTestApp).toBe(true)
  }, 30000)

  it('should create and delete channel with hashed API key', async () => {
    const sdk = createHashedKeySDK()
    const channelName = `test-hashed-channel-${Date.now()}`

    // Create channel
    const createResult = await sdk.addChannel({
      appId: APPNAME,
      channelId: channelName,
    })
    expect(createResult.success).toBe(true)

    // Verify channel exists
    const listResult = await sdk.listChannels(APPNAME)
    expect(listResult.success).toBe(true)
    const channelExists = listResult.data?.some((ch: any) => ch.name === channelName)
    expect(channelExists).toBe(true)

    // Delete channel
    const deleteResult = await sdk.deleteChannel(channelName, APPNAME)
    expect(deleteResult.success).toBe(true)
  }, 30000)

  it('should get current bundle with hashed API key', async () => {
    const sdk = createHashedKeySDK()

    // Just verify we can get the current bundle for the production channel
    // The bundle should have been set by the first upload test
    const bundleResult = await sdk.getCurrentBundle(APPNAME, 'production')
    expect(bundleResult.success).toBe(true)
    // The result should be a version string
    expect(typeof bundleResult.data).toBe('string')
  }, 30000)

  it('should update channel with hashed API key', async () => {
    const sdk = createHashedKeySDK()

    // Update channel settings
    const updateResult = await sdk.updateChannel({
      appId: APPNAME,
      channelId: 'production',
      ios: true,
      android: true,
    })
    expect(updateResult.success).toBe(true)
  }, 30000)
})
