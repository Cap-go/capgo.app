/**
 * Native project archive for Capgo Builder.
 *
 * Shared by `build request` (which uploads the archive to the builder) and the
 * offline `build zip` packer (which only writes it to disk so an agent can upload
 * it through a signed URL). Everything here is local: no API key, no network.
 */

import type { BuildOptionsPayload } from '../schemas/build'
import { Buffer } from 'node:buffer'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile as readFileAsync, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { getPlatformDirFromCapacitorConfig, normalizeNativeDependencyPathsInText } from './platform-paths'
import { syncAndroidVersion } from './android-version'
import { syncIosMarketingVersion } from './ios-marketing-version'

/**
 * Extract native node_modules roots that contain platform folders.
 */
export interface NativeDependencies {
  packages: Set<string> // Capacitor package paths like @capacitor/app
  cordovaPackages: Set<string> // Cordova plugin package paths like onesignal-cordova-plugin
  usesSPM: boolean
  usesCocoaPods: boolean
}

export interface ZipDirectoryOptions {
  nodeModules?: string
}

async function extractNativeDependencies(
  projectDir: string,
  platform: 'ios' | 'android',
  platformDir: string,
): Promise<NativeDependencies> {
  const packages = new Set<string>()
  const cordovaPackages = new Set<string>()
  let usesSPM = false
  let usesCocoaPods = false

  if (platform === 'ios') {
    // Detect Swift Package Manager dependencies from CapApp-SPM/Package.swift when present.
    const spmPackagePath = join(projectDir, platformDir, 'App', 'CapApp-SPM', 'Package.swift')
    if (existsSync(spmPackagePath)) {
      usesSPM = true
      const spmContent = await readFileAsync(spmPackagePath, 'utf-8')
      // Match lines like: .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")
      // The path can have varying numbers of ../ depending on project structure
      const spmMatches = spmContent.matchAll(/\.package\s*\([^)]*path:\s*["'](?:\.\.[\\/])*node_modules[\\/]([^"']+)["']\s*\)/g)
      for (const match of spmMatches) {
        let pkgPath = match[1].replace(/\\/g, '/')
        const lastNmIdx = pkgPath.lastIndexOf('node_modules/')
        if (lastNmIdx !== -1)
          pkgPath = pkgPath.substring(lastNmIdx + 'node_modules/'.length)
        packages.add(pkgPath)
      }
    }

    // Detect CocoaPods dependencies from Podfile(s). SPM and CocoaPods may coexist.
    const iosDir = join(projectDir, platformDir)
    if (existsSync(iosDir)) {
      const candidates: string[] = [
        join(iosDir, 'App', 'Podfile'),
        join(iosDir, 'Podfile'),
      ]

      for (const child of readdirSync(iosDir, { withFileTypes: true })) {
        if (child.isDirectory()) {
          candidates.push(join(iosDir, child.name, 'Podfile'))
        }
      }

      const uniqPodfiles = [...new Set(candidates)].filter(candidate => existsSync(candidate))
      if (uniqPodfiles.length > 0)
        usesCocoaPods = true

      for (const podfilePath of uniqPodfiles) {
        const podfileContent = await readFileAsync(podfilePath, 'utf-8')
        // Match lines like: pod 'CapacitorApp', :path => '../../node_modules/@capacitor/app'
        const podMatches = podfileContent.matchAll(/pod\s+['"][^'"]+['"],\s*:path\s*=>\s*['"](?:\.\.[\\/])+node_modules[\\/]([^'"]+)['"]/g)
        for (const match of podMatches) {
          let pkgPath = match[1]
          const lastNmIdx = pkgPath.lastIndexOf('node_modules/')
          if (lastNmIdx !== -1)
            pkgPath = pkgPath.substring(lastNmIdx + 'node_modules/'.length)
          packages.add(pkgPath)
        }
      }
    }
  }
  else if (platform === 'android') {
    // Parse Android capacitor.settings.gradle
    const settingsGradlePath = join(projectDir, platformDir, 'capacitor.settings.gradle')
    if (existsSync(settingsGradlePath)) {
      const settingsContent = await readFileAsync(settingsGradlePath, 'utf-8')
      // Match lines like: project(':capacitor-app').projectDir = new File('../node_modules/@capacitor/app/android')
      // Also matches pnpm paths: new File('../node_modules/.pnpm/@pkg@ver/node_modules/@scope/pkg/android')
      const gradleMatches = settingsContent.matchAll(/new\s+File\s*\(\s*['"]\.\.[\\/]node_modules[\\/]([^'"]+)['"]\s*\)/g)
      for (const match of gradleMatches) {
        let fullPath = match[1].replace(/\\/g, '/')

        // Normalize pnpm paths: .pnpm/@pkg+name@ver/node_modules/@scope/pkg/android → @scope/pkg
        const lastNodeModulesIdx = fullPath.lastIndexOf('node_modules/')
        if (lastNodeModulesIdx !== -1) {
          fullPath = fullPath.substring(lastNodeModulesIdx + 'node_modules/'.length)
        }

        // Strip platform directory suffixes (android, capacitor for @capacitor/android)
        const packagePath = fullPath.replace(/\/(android|capacitor)$/, '')
        packages.add(packagePath)
      }
    }

    // Parse Cordova plugin references from capacitor-cordova-android-plugins/build.gradle.
    // These plugins are NOT listed in capacitor.settings.gradle. They are wired via
    // `apply from: "../../node_modules/<plugin>/<file>.gradle"` lines that `cap sync`
    // injects between the PLUGIN GRADLE EXTENSIONS markers. The referenced files live
    // at the package root, not under an `android/` subfolder, so we must include the
    // entire package contents in the upload bundle.
    const cordovaBuildGradlePath = join(projectDir, platformDir, 'capacitor-cordova-android-plugins', 'build.gradle')
    if (existsSync(cordovaBuildGradlePath)) {
      const cordovaContent = await readFileAsync(cordovaBuildGradlePath, 'utf-8')
      // Match: apply from: "../../node_modules/<pkg>/..." (any depth of ../, single or double quotes)
      const applyFromMatches = cordovaContent.matchAll(/apply\s+from\s*:\s*["'](?:\.\.\/)+node_modules\/([^"']+)["']/g)
      for (const match of applyFromMatches) {
        let fullPath = match[1]
        // Normalize pnpm paths
        const lastNodeModulesIdx = fullPath.lastIndexOf('node_modules/')
        if (lastNodeModulesIdx !== -1)
          fullPath = fullPath.substring(lastNodeModulesIdx + 'node_modules/'.length)
        // Extract package name: scoped (@scope/pkg) takes two segments, otherwise one
        const segments = fullPath.split('/')
        const packagePath = segments[0].startsWith('@') && segments.length >= 2
          ? `${segments[0]}/${segments[1]}`
          : segments[0]
        cordovaPackages.add(packagePath)
      }
    }
  }

  return { packages, cordovaPackages, usesSPM, usesCocoaPods }
}

/**
 * Detect the iOS dependency manager the same way the Capacitor CLI does:
 * a Podfile in the native App folder means CocoaPods, otherwise a CapApp-SPM
 * package means Swift Package Manager. Reported to Capgo for build analytics.
 */
export function detectIosDependencyManager(projectDir: string, platformDir: string): 'cocoapods' | 'spm' | undefined {
  const appDir = join(projectDir, platformDir, 'App')
  if (existsSync(join(appDir, 'Podfile')))
    return 'cocoapods'
  if (existsSync(join(appDir, 'CapApp-SPM', 'Package.swift')))
    return 'spm'
  return undefined
}

/**
 * Check if a file path should be included in the zip
 */
export function shouldIncludeFile(filePath: string, platform: 'ios' | 'android', nativeDeps: NativeDependencies, platformDir: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/')

  // Always include platform folder
  if (normalizedPath.startsWith(`${platformDir}/`))
    return true

  // Always include config files at root
  if (normalizedPath === 'package.json' || normalizedPath === 'package-lock.json' || normalizedPath.startsWith('capacitor.config.'))
    return true

  // Include resources folder
  if (normalizedPath.startsWith('resources/'))
    return true

  // Include @capacitor core for the platform
  if (platform === 'ios' && normalizedPath.startsWith('node_modules/@capacitor/ios/'))
    return true
  if (platform === 'android' && normalizedPath.startsWith('node_modules/@capacitor/android/'))
    return true

  // Cordova plugins: include the entire package contents EXCEPT the plugin's own
  // nested node_modules. Cordova plugins don't follow Capacitor's `<pkg>/android/`
  // convention — supporting files like `build-extras-*.gradle` live at the package
  // root, native sources may live under `src/android/`, and `plugin.xml` is at the
  // root. We include all of those, but exclude any bundled transitive dependencies
  // under `<pkg>/node_modules/...` to avoid pulling unrelated code (and arbitrary
  // size) into the upload bundle.
  if (platform === 'android') {
    for (const cordovaPkg of nativeDeps.cordovaPackages) {
      const cordovaPrefix = `node_modules/${cordovaPkg}/`
      if (normalizedPath === `node_modules/${cordovaPkg}/package.json`)
        return true
      if (normalizedPath.startsWith(cordovaPrefix)) {
        const subpath = normalizedPath.slice(cordovaPrefix.length)
        // Reject anything inside the plugin's own bundled node_modules.
        if (subpath === 'node_modules' || subpath.startsWith('node_modules/'))
          continue
        return true
      }
    }
  }

  // Check if file is in one of the native dependencies
  for (const packagePath of nativeDeps.packages) {
    const packagePrefix = `node_modules/${packagePath}/`

    // Native dependency package metadata used by some podspecs/gradle scripts.
    if (normalizedPath === `${packagePrefix}package.json`)
      return true

    if (platform === 'android') {
      // For Android, only include the android/ subfolder
      if (normalizedPath.startsWith(`${packagePrefix}android/`))
        return true
    }
    else if (platform === 'ios') {
      // For iOS, include ios/ folder and either Package.swift (SPM) or *.podspec (CocoaPods)
      if (normalizedPath.startsWith(`${packagePrefix}ios/`))
        return true

      if (nativeDeps.usesSPM) {
        // SPM: include Package.swift
        if (normalizedPath === `${packagePrefix}Package.swift`)
          return true
      }
      if (nativeDeps.usesCocoaPods || !nativeDeps.usesSPM) {
        // CocoaPods: include *.podspec files (also when neither manager is explicitly detected)
        if (normalizedPath.startsWith(packagePrefix) && normalizedPath.endsWith('.podspec'))
          return true
      }
    }
  }

  return false
}

/**
 * Recursively add directory to zip with filtering
 */
function addDirectoryToZip(
  zip: AdmZip,
  dirPath: string,
  zipPath: string,
  platform: 'ios' | 'android',
  nativeDeps: NativeDependencies,
  platformDir: string,
) {
  const items = readdirSync(dirPath)

  for (const item of items) {
    const itemPath = join(dirPath, item)
    const itemZipPath = zipPath ? `${zipPath}/${item}` : item
    const stats = statSync(itemPath)

    if (stats.isDirectory()) {
      // Skip excluded directories
      // .git: version control
      // dist, build, .angular, .vite: build output directories
      // .gradle, .idea: Android build cache and IDE settings
      // .swiftpm: Swift Package Manager cache
      if (item === '.git' || item === 'dist' || item === 'build' || item === '.angular' || item === '.vite' || item === '.gradle' || item === '.idea' || item === '.swiftpm')
        continue

      // Always recurse into node_modules (we filter inside)
      if (item === 'node_modules') {
        addDirectoryToZip(zip, itemPath, itemZipPath, platform, nativeDeps, platformDir)
        continue
      }

      // For resources folder, always recurse
      if (item === 'resources') {
        addDirectoryToZip(zip, itemPath, itemZipPath, platform, nativeDeps, platformDir)
        continue
      }

      // For other directories, check if we need to recurse into them
      // We should recurse if:
      // 1. This directory itself should be included (matches a pattern)
      // 2. This directory is a prefix of a dependency path (need to traverse to reach it)
      const normalizedItemPath = itemZipPath.replace(/\\/g, '/')
      const allPackages = [...nativeDeps.packages, ...nativeDeps.cordovaPackages]
      const shouldRecurse = shouldIncludeFile(itemZipPath, platform, nativeDeps, platformDir)
        // Ensure we can reach nested platform directories like projects/app/android.
        || platformDir === normalizedItemPath
        || platformDir.startsWith(`${normalizedItemPath}/`)
        || allPackages.some((pkg) => {
          const depPath = `node_modules/${pkg}/`
          return depPath.startsWith(`${normalizedItemPath}/`) || normalizedItemPath.startsWith(`node_modules/${pkg}`)
        })

      if (shouldRecurse) {
        addDirectoryToZip(zip, itemPath, itemZipPath, platform, nativeDeps, platformDir)
      }
    }
    else if (stats.isFile()) {
      // Skip excluded files
      if (item === '.DS_Store' || item.endsWith('.log'))
        continue

      // Check if we should include this file
      if (shouldIncludeFile(itemZipPath, platform, nativeDeps, platformDir)) {
        addFileToZip(zip, itemPath, itemZipPath)
      }
    }
  }
}

function addFileToZip(zip: AdmZip, filePath: string, zipEntryPath: string) {
  const normalizedEntryPath = zipEntryPath.replace(/\\/g, '/')
  if (zip.getEntry(normalizedEntryPath))
    return

  const lastSlashIndex = normalizedEntryPath.lastIndexOf('/')
  const zipFolder = lastSlashIndex === -1 ? undefined : normalizedEntryPath.slice(0, lastSlashIndex)
  zip.addLocalFile(filePath, zipFolder)
}

function parseNodeModulesPaths(nodeModules: string | undefined): string[] {
  if (!nodeModules)
    return []

  const paths = nodeModules
    .split(',')
    .map(nodeModulesPath => nodeModulesPath.trim())
    .filter(Boolean)
    .map(nodeModulesPath => resolve(nodeModulesPath))

  return [...new Set(paths)]
}

function getNativePackagePaths(platform: 'ios' | 'android', nativeDeps: NativeDependencies): Set<string> {
  const packages = new Set([...nativeDeps.packages, ...nativeDeps.cordovaPackages])
  packages.add(platform === 'ios' ? '@capacitor/ios' : '@capacitor/android')
  return packages
}

function findPackageInNodeModules(nodeModulesPath: string, packagePath: string): string | undefined {
  const directPackageDir = join(nodeModulesPath, ...packagePath.split('/'))
  if (existsSync(directPackageDir))
    return directPackageDir

  const pnpmStoreDir = join(nodeModulesPath, '.pnpm')
  if (!existsSync(pnpmStoreDir))
    return undefined

  const encodedPackageName = packagePath.replace('/', '+')
  const pnpmEntries = readdirSync(pnpmStoreDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name.startsWith(`${encodedPackageName}@`))
    .sort()

  if (pnpmEntries.length > 1) {
    throw new Error(`Multiple pnpm store entries found for ${packagePath} in ${pnpmStoreDir}; provide the app-specific node_modules path so the native build archive can use the exact resolved package.`)
  }

  for (const entry of pnpmEntries) {
    const packageDir = join(pnpmStoreDir, entry, 'node_modules', ...packagePath.split('/'))
    if (existsSync(packageDir))
      return packageDir
  }

  return undefined
}

function addNativePackagesFromNodeModules(
  zip: AdmZip,
  nodeModulesPaths: string[],
  platform: 'ios' | 'android',
  nativeDeps: NativeDependencies,
  platformDir: string,
) {
  if (nodeModulesPaths.length === 0)
    return

  const missingPaths = nodeModulesPaths.filter(nodeModulesPath => !existsSync(nodeModulesPath))
  if (missingPaths.length > 0)
    throw new Error(`Missing node_modules folder at ${missingPaths.join(', ')}`)

  for (const nodeModulesPath of nodeModulesPaths) {
    for (const packagePath of getNativePackagePaths(platform, nativeDeps)) {
      const packageDir = findPackageInNodeModules(nodeModulesPath, packagePath)
      if (!packageDir)
        continue

      addDirectoryToZip(
        zip,
        packageDir,
        `node_modules/${packagePath}`,
        platform,
        nativeDeps,
        platformDir,
      )
    }
  }
}

/**
 * Zip directory for native build, including only necessary files:
 * - ios/ OR android/ folder (based on platform)
 * - node_modules with native code (from Podfile/settings.gradle)
 * - capacitor.config.*, package.json, package-lock.json
 * Zip contents are the user's responsibility, not Capgo's; Capgo packages the user-provided files as-is.
 */
export async function zipDirectory(projectDir: string, outputPath: string, platform: 'ios' | 'android', capConfig: any, options: ZipDirectoryOptions = {}): Promise<void> {
  const platformDir = getPlatformDirFromCapacitorConfig(capConfig, platform)

  // Extract which node_modules have native code for this platform
  const nativeDeps = await extractNativeDependencies(projectDir, platform, platformDir)

  const zip = new AdmZip()

  // Add files with filtering
  addDirectoryToZip(zip, projectDir, '', platform, nativeDeps, platformDir)
  addNativePackagesFromNodeModules(zip, parseNodeModulesPaths(options.nodeModules), platform, nativeDeps, platformDir)

  // Rewrite isolated-linker store paths to standard flat paths (node_modules/@scope/pkg).
  // Both pnpm (node_modules/.pnpm/…/node_modules/@scope/pkg) and bun's isolated linker
  // (node_modules/.bun/@scope+pkg@ver+hash/node_modules/@scope/pkg) leak store paths into
  // Package.swift, Podfile, Podfile.lock, Pods.xcodeproj/project.pbxproj, .xcconfig files,
  // Manifest.lock, settings.gradle, etc. The cloud builder only ships the flat plugin dirs,
  // so these store paths must be collapsed back to node_modules/@scope/pkg.
  const pnpmPathPattern = /node_modules\/\.pnpm\/[^/\n\r]+(?:\/[^/\n\r]+)*\/node_modules\//g
  const bunPathPattern = /node_modules\/\.bun\/[^/\n\r]+(?:\/[^/\n\r]+)*\/node_modules\//g
  const textExtensions = new Set([
    '',
    '.gradle',
    '.swift',
    '.json',
    '.lock',
    '.xml',
    '.properties',
    '.pbxproj',
    '.xcconfig',
    '.plist',
    '.podspec',
    '.rb',
    '.yaml',
    '.yml',
  ])
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory)
      continue
    const ext = entry.entryName.includes('.') ? `.${entry.entryName.split('.').pop()}` : ''
    const basename = entry.entryName.split('/').pop() || ''
    if (!textExtensions.has(ext) && basename !== 'Podfile')
      continue
    const original = entry.getData().toString('utf-8')
    let rewritten = normalizeNativeDependencyPathsInText(original)
    rewritten = rewritten.replace(pnpmPathPattern, 'node_modules/').replace(bunPathPattern, 'node_modules/')

    // pnpm can leave deep relative paths in iOS files like Package.swift and Pods output.
    // Collapse any excessive ../ before project-root ios/ or node_modules/ paths back to
    // the current zip entry's actual depth.
    if (platform === 'ios') {
      const rootRelativePrefix = '../'.repeat(entry.entryName.split('/').length - 1)
      rewritten = rewritten.replace(
        /(?:\.\.\/){4,}(ios\/|node_modules\/)/g,
        (_match, rootPath: string) => `${rootRelativePrefix}${rootPath}`,
      )
    }

    if (rewritten !== original) {
      zip.updateFile(entry.entryName, Buffer.from(rewritten, 'utf-8'))
    }
  }

  // Cloud builders may only parse JSON configs. Ensure a resolved JSON exists even if the project
  // uses capacitor.config.ts/js, so android.path/ios.path is visible remotely.
  const configJsonPath = join(projectDir, 'capacitor.config.json')
  if (capConfig && !existsSync(configJsonPath)) {
    const json = `${JSON.stringify(capConfig, null, 2)}\n`
    zip.addFile('capacitor.config.json', Buffer.from(json, 'utf-8'))
  }

  // Write zip to file
  await writeFile(outputPath, zip.toBuffer())
}

/**
 * Credential-map keys that tell the builder where the native project lives.
 * `build request` merges these into the credentials map (they are later moved to
 * build_options by splitPayload, never sent as secrets).
 */
export function nativeProjectDirCredentials(platform: 'ios' | 'android', nativeProjectDir: string | undefined): Record<string, string> {
  if (!nativeProjectDir)
    return {}
  if (platform === 'ios') {
    return {
      CAPGO_IOS_SOURCE_DIR: nativeProjectDir,
      CAPGO_IOS_APP_DIR: nativeProjectDir,
      CAPGO_IOS_PROJECT_DIR: nativeProjectDir,
      IOS_PROJECT_DIR: nativeProjectDir,
    }
  }
  return {
    CAPGO_ANDROID_SOURCE_DIR: nativeProjectDir,
    CAPGO_ANDROID_APP_DIR: nativeProjectDir,
    CAPGO_ANDROID_PROJECT_DIR: nativeProjectDir,
    ANDROID_PROJECT_DIR: nativeProjectDir,
  }
}

/** build_options fields derived from the local project layout (see splitPayload). */
export const PROJECT_DERIVED_BUILD_OPTION_KEYS = [
  'iosSourceDir',
  'iosAppDir',
  'iosProjectDir',
  'androidSourceDir',
  'androidAppDir',
  'androidProjectDir',
] as const satisfies ReadonlyArray<keyof BuildOptionsPayload>

export interface LocalNativeVersionSyncOptions {
  syncIosVersion?: boolean
  syncAndroidVersion?: boolean
}

/**
 * Optional local version sync (--sync-ios-version / --sync-android-version), run
 * before the native project is archived. Edits files inside the project only.
 */
export function syncLocalNativeVersion(
  platform: 'ios' | 'android',
  projectDir: string,
  options: LocalNativeVersionSyncOptions,
  info: (message: string) => void,
): void {
  if (platform === 'ios' && options.syncIosVersion) {
    const syncResult = syncIosMarketingVersion({ path: projectDir })
    info(syncResult.changed
      ? `Synced iOS app version to ${syncResult.marketingVersion}`
      : `iOS app version is already ${syncResult.marketingVersion}`)
  }

  if (platform === 'android' && options.syncAndroidVersion) {
    const syncResult = syncAndroidVersion({ path: projectDir })
    info(syncResult.changed
      ? `Synced Android app version to ${syncResult.packageVersion}`
      : `Android app version is already ${syncResult.packageVersion}`)
  }
}

