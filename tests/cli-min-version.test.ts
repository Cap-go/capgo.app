import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestSDK, uploadBundleSDK } from './cli-sdk-utils'
import { cleanupCli, getSemver, prepareCli } from './cli-utils'
import { createIsolatedSeedAppOptions, getSupabaseClient, resetAndSeedAppData, resetAppData, resetAppDataStats } from './test-utils'

async function writeBundleContent(appId: string, marker: string) {
  const indexHtmlPath = join(process.cwd(), 'temp_cli_test', appId, 'dist', 'index.html')
  await writeFile(indexHtmlPath, `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CLI Min Version Test</title>
</head>
<body>
  <h1>${marker}</h1>
  <script>
    if (window.CapacitorUpdater) {
      window.CapacitorUpdater.notifyAppReady();
    }
  </script>
</body>
</html>`)
}

describe('tests min version', () => {
  const id = randomUUID()
  const APPNAME = `com.cli_min_version_${id}`
  const seedOptions = createIsolatedSeedAppOptions()

  beforeAll(async () => {
    await Promise.all([
      resetAndSeedAppData(APPNAME, seedOptions),
      prepareCli(APPNAME, false, false), // Use main project dependencies instead
    ])
  })

  afterAll(async () => {
    await Promise.all([
      cleanupCli(APPNAME),
      resetAppData(APPNAME),
      resetAppDataStats(APPNAME),
    ])
  })

  it('should test auto min version flag', async () => {
    const supabase = getSupabaseClient()

    const { error } = await supabase.from('app_versions').update({ min_update_version: '1.0.0' }).eq('name', '1.0.0').eq('app_id', APPNAME).throwOnError()
    expect(error).toBeNull()

    // Use a fixed version instead of timestamp-based to avoid timing issues
    const testId = Math.floor(Math.random() * 1000000)
    const semverDefault = `1.0.${testId}`
    const channelName = `min-version-${testId}`
    const packageJsonPath = join(process.cwd(), 'temp_cli_test', APPNAME, 'package.json')
    const sdk = createTestSDK()

    const createChannelResult = await sdk.addChannel({
      appId: APPNAME,
      channelId: channelName,
    })
    expect(createChannelResult.success).toBe(true)

    const linkSeedBundleResult = await sdk.updateChannel({
      appId: APPNAME,
      channelId: channelName,
      bundle: '1.0.0',
    })
    expect(linkSeedBundleResult.success).toBe(true)

    await writeBundleContent(APPNAME, `auto-min-${semverDefault}`)

    // Upload with auto-min-update-version:app_versions!channels_version_fkey(needs metadata check enabled)
    const result0 = await uploadBundleSDK(APPNAME, semverDefault, channelName, {
      ignoreCompatibilityCheck: false,
      packageJsonPaths: packageJsonPath,
      autoMinUpdateVersion: true,
    })
    expect(result0.success).toBe(true)

    // Check that min_update_version was auto-set
    const { data, error: checkError } = await supabase
      .from('app_versions')
      .select('min_update_version')
      .eq('name', semverDefault)
      .eq('app_id', APPNAME)
      .single()
      .throwOnError()
    expect(checkError).toBeNull()
    // The auto-min-update-version should have set a value
    expect(data?.min_update_version).toBeDefined()

    const { error: clearError } = await supabase
      .from('app_versions')
      .update({ min_update_version: null })
      .eq('name', semverDefault)
      .eq('app_id', APPNAME)
      .throwOnError()
    expect(clearError).toBeNull()

    // Upload a new version with auto-min-update-version
    // This should FAIL because native_packages aren't set on previous version
    const semverNew = getSemver(semverDefault)
    await writeBundleContent(APPNAME, `auto-min-${semverNew}`)
    const result1 = await uploadBundleSDK(APPNAME, semverNew, channelName, {
      ignoreCompatibilityCheck: false,
      packageJsonPaths: packageJsonPath,
      autoMinUpdateVersion: true,
    })
    const result1Error = result1.error ?? ''

    // This upload should fail with auto-setting compatibility error
    expect(result1.success).toBe(false)
    expect(
      result1Error.includes('Cannot auto set compatibility')
      || result1Error.includes('Error fetching native packages')
      || result1Error.includes('Invalid remote min update version'),
    ).toBe(true)

    // The new version should NOT exist because upload failed
    const { data: dataNew, error: checkErrorNew } = await supabase
      .from('app_versions')
      .select('min_update_version')
      .eq('name', semverNew)
      .eq('app_id', APPNAME)
      .single()
    expect(checkErrorNew).toBeDefined()
    expect(dataNew).toBeNull()

    // Clear native_packages from previous version to simulate first upload
    const { error: error2 } = await supabase
      .from('app_versions')
      .update({ min_update_version: null, native_packages: null })
      .eq('name', semverDefault)
      .eq('app_id', APPNAME)
      .throwOnError()
    expect(error2).toBeNull()

    // Upload with auto-min-update-version when previous version has no native_packages
    const semverWithNull = `1.0.${testId + 2}`
    await writeBundleContent(APPNAME, `auto-min-${semverWithNull}`)
    const result2 = await uploadBundleSDK(APPNAME, semverWithNull, channelName, {
      ignoreCompatibilityCheck: false,
      packageJsonPaths: packageJsonPath,
      autoMinUpdateVersion: true,
    })

    // Should succeed - it's first upload with compatibility check after clearing metadata.
    expect(result2.success).toBe(true)
  }, 30000)
})
