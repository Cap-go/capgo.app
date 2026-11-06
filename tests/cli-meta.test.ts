import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestSDK, uploadBundleSDK } from './cli-sdk-utils'
import { BASE_PACKAGE_JSON, cleanupCli, getSemver, prepareCli, tempFileFolder } from './cli-utils'
import { createIsolatedSeedAppOptions, resetAndSeedAppData, resetAppData, resetAppDataStats } from './test-utils'

async function assertCompatibilityTableColumns(appId: string, packageName: string, localVersion: string, remoteVersion: string, customPackageJsonPath?: string) {
  const packageJsonPath = customPackageJsonPath || join(process.cwd(), 'temp_cli_test', appId, 'package.json')
  const result = await createTestSDK().checkBundleCompatibility({
    appId,
    channel: 'production',
    packageJson: packageJsonPath,
    nodeModules: join(process.cwd(), 'node_modules'),
  })

  expect(result.success).toBe(true)
  const packageEntry = result.data?.find((entry: any) => entry.name === packageName)
  expect(packageEntry).toBeDefined()
  expect(packageEntry!.localVersion).toContain(localVersion)
  expect(packageEntry!.remoteVersion).toContain(remoteVersion)
}

async function writeBundleContent(appId: string, marker: string) {
  const indexHtmlPath = join(tempFileFolder(appId), 'dist', 'index.html')
  await writeFile(indexHtmlPath, `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CLI Metadata Test</title>
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

async function getInstalledDependencyVersion(packageName: string): Promise<string> {
  const packageJsonPath = join(process.cwd(), 'node_modules', ...packageName.split('/'), 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version: string }
  return packageJson.version
}

async function createCustomPackageJson(appId: string, testName: string, dependencies: Record<string, string>): Promise<string> {
  const customPath = join(tempFileFolder(appId), `package-${testName}.json`)
  const packageContent = BASE_PACKAGE_JSON
    .replace('%APPID%', appId)
    .replace('%DEPENDENCIES%', JSON.stringify(dependencies, null, 2))
  await writeFile(customPath, packageContent)
  return customPath
}

describe('tests CLI metadata', () => {
  const id = randomUUID()
  const APPNAME = `com.cli_meta_${id}`
  const seedOptions = createIsolatedSeedAppOptions()
  let installedAndroidVersion = ''
  let installedUpdaterVersion = ''

  beforeAll(async () => {
    const [androidVersion, updaterVersion] = await Promise.all([
      getInstalledDependencyVersion('@capacitor/android'),
      getInstalledDependencyVersion('@capgo/capacitor-updater'),
      resetAndSeedAppData(APPNAME, seedOptions),
      prepareCli(APPNAME, false, false), // Use main project dependencies instead
    ])

    installedAndroidVersion = androidVersion
    installedUpdaterVersion = updaterVersion
  })

  afterAll(async () => {
    await Promise.all([
      cleanupCli(APPNAME),
      resetAppData(APPNAME),
      resetAppDataStats(APPNAME),
    ])
  })

  it('should upload bundle with metadata check', async () => {
    const testSemver = getSemver()
    const packageJsonPath = join(process.cwd(), 'temp_cli_test', APPNAME, 'package.json')
    await writeBundleContent(APPNAME, `metadata-${testSemver}`)

    // First upload a bundle WITH metadata to establish baseline
    const result = await uploadBundleSDK(APPNAME, testSemver, 'production', {
      ignoreCompatibilityCheck: false,
      packageJsonPaths: packageJsonPath,
    })
    expect(result.success).toBe(true)

    // Now compatibility check should show remote versions from the uploaded bundle
    // The SDK reports the currently installed dependency version from node_modules.
    await assertCompatibilityTableColumns(APPNAME, '@capacitor/android', installedAndroidVersion, installedAndroidVersion)
  })

  // Each case writes its own package.json and compares against the uploaded baseline.
  // localVersion always comes from node_modules, not from the declared dependency.
  it.concurrent.each([
    ['matching versions', () => installedAndroidVersion],
    ['semver caret ranges', () => '^8.0.0'],
    ['semver tilde ranges', () => '~8.0.0'],
    ['major version mismatches', () => '7.0.0'],
    ['registry prefixes', () => 'npm:@capacitor/android@8.0.0'],
    ['file references', () => 'file:../capacitor-android'],
    ['git references', () => 'github:capacitorjs/capacitor#main'],
  ])('should resolve %s against the installed dependency', async (testName, declaredVersion) => {
    const customPkgPath = await createCustomPackageJson(APPNAME, testName.replaceAll(' ', '-'), { '@capacitor/android': declaredVersion() })
    await assertCompatibilityTableColumns(APPNAME, '@capacitor/android', installedAndroidVersion, installedAndroidVersion, customPkgPath)
  })

  it.concurrent('should handle additional local plugins', async () => {
    const customPkgPath = await createCustomPackageJson(APPNAME, 'plugins', {
      '@capacitor/android': installedAndroidVersion,
      '@capgo/capacitor-updater': installedUpdaterVersion,
    })
    await assertCompatibilityTableColumns(APPNAME, '@capacitor/android', installedAndroidVersion, installedAndroidVersion, customPkgPath)
    await assertCompatibilityTableColumns(APPNAME, '@capgo/capacitor-updater', installedUpdaterVersion, installedUpdaterVersion, customPkgPath)
  })
})
