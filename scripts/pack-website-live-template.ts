#!/usr/bin/env bun
/**
 * Pack the Capgo "Web2App" native app template into dist/website-live-template.zip.
 *
 * The zip mirrors what `capgo build request` uploads (cli/src/build/request.ts zipDirectory):
 * package.json, capacitor.config.* (plus a resolved capacitor.config.json), the native ios/ and
 * android/ folders, and only the native folders of node_modules plugins referenced by
 * CapApp-SPM/Package.swift and capacitor.settings.gradle. Unlike the CLI (one platform per zip),
 * this zip contains both platforms so the server can patch it once and send it for either build.
 *
 * A manifest.json at the zip root lists the placeholder values and every file containing them.
 *
 * Usage: bun scripts/pack-website-live-template.ts [--out dist/website-live-template.zip]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import AdmZip from 'adm-zip'

const repoRoot = resolve(import.meta.dir, '..')
const templateDir = join(repoRoot, 'templates', 'website-live-app')
const outArgIndex = process.argv.indexOf('--out')
const outPath = resolve(repoRoot, outArgIndex !== -1 ? process.argv[outArgIndex + 1] : 'dist/website-live-template.zip')

const PLACEHOLDERS = {
  bundleId: 'app.capgo.websitelive.template',
  appName: 'Web2App Template',
  websiteUrl: 'https://example.com',
} as const

const IOS_ICON_PATH = 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'
const ANDROID_ICON_PATHS = {
  launcher: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
  launcherRound: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png',
  launcherForeground: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png',
  backgroundColor: 'android/app/src/main/res/values/ic_launcher_background.xml',
}
const RESOLVED_CONFIG_PATH = 'capacitor.config.json'
const CAPACITOR_CONFIG_PATHS = [
  'capacitor.config.ts',
  RESOLVED_CONFIG_PATH,
  'ios/App/App/capacitor.config.json',
  'android/app/src/main/assets/capacitor.config.json',
]

// Same directory exclusions as the CLI, plus local machine / Xcode / CocoaPods outputs.
const EXCLUDED_DIRS = new Set(['.git', 'dist', 'build', '.angular', '.vite', '.gradle', '.idea', '.swiftpm', '.kotlin', '.build', 'Pods', 'DerivedData', 'xcuserdata', 'output'])
const EXCLUDED_FILES = new Set(['.DS_Store', 'local.properties'])
// Deterministic entry timestamps so identical inputs give an identical zip.
const FIXED_DATE = new Date('2020-01-01T00:00:00Z')

function fail(message: string): never {
  console.error(`pack-website-live-template: ${message}`)
  process.exit(1)
}

function readText(path: string): string {
  return readFileSync(join(templateDir, path), 'utf-8')
}

function stripToPackage(rawPath: string): string {
  const path = rawPath.replace(/\\/g, '/')
  const idx = path.lastIndexOf('node_modules/')
  return idx === -1 ? path : path.slice(idx + 'node_modules/'.length)
}

/** Native plugin packages, parsed exactly like the CLI's extractNativeDependencies. */
function nativePackages() {
  const ios = new Set<string>()
  const android = new Set<string>()
  const spm = 'ios/App/CapApp-SPM/Package.swift'
  if (!existsSync(join(templateDir, spm)))
    fail(`${spm} missing: run "bunx cap sync" in templates/website-live-app`)
  for (const m of readText(spm).matchAll(/\.package\s*\([^)]*path:\s*["'](?:\.\.[\\/])*node_modules[\\/]([^"']+)["']\s*\)/g))
    ios.add(stripToPackage(m[1]))
  const settings = 'android/capacitor.settings.gradle'
  if (!existsSync(join(templateDir, settings)))
    fail(`${settings} missing: run "bunx cap sync" in templates/website-live-app`)
  for (const m of readText(settings).matchAll(/new\s+File\s*\(\s*['"]\.\.[\\/]node_modules[\\/]([^'"]+)['"]\s*\)/g))
    android.add(stripToPackage(m[1]).replace(/\/(android|capacitor)$/, ''))
  if (existsSync(join(templateDir, 'ios/App/Podfile')))
    fail('ios/App/Podfile found: the template must use Swift Package Manager')
  return { ios, android }
}

function shouldInclude(path: string, deps: ReturnType<typeof nativePackages>): boolean {
  if (path.startsWith('ios/') || path.startsWith('android/'))
    return true
  if (path === 'package.json' || path === 'bun.lock' || path.startsWith('capacitor.config.'))
    return true
  if (path.startsWith('node_modules/@capacitor/ios/') || path.startsWith('node_modules/@capacitor/android/'))
    return true
  for (const pkg of new Set([...deps.ios, ...deps.android])) {
    const prefix = `node_modules/${pkg}/`
    if (path === `${prefix}package.json`)
      return true
    if (deps.android.has(pkg) && path.startsWith(`${prefix}android/`))
      return true
    if (deps.ios.has(pkg) && (path.startsWith(`${prefix}ios/`) || path === `${prefix}Package.swift`))
      return true
  }
  return false
}

function walk(dir: string, deps: ReturnType<typeof nativePackages>, out: string[]) {
  for (const item of readdirSync(dir).sort()) {
    const abs = join(dir, item)
    const rel = relative(templateDir, abs).replace(/\\/g, '/')
    const stats = statSync(abs)
    if (stats.isDirectory()) {
      if (EXCLUDED_DIRS.has(item))
        continue
      const pkgs = [...deps.ios, ...deps.android, '@capacitor/ios', '@capacitor/android']
      const reachable = rel === 'node_modules'
        || shouldInclude(`${rel}/`, deps)
        || pkgs.some(pkg => `node_modules/${pkg}/`.startsWith(`${rel}/`) || rel.startsWith(`node_modules/${pkg}`))
      if (reachable)
        walk(abs, deps, out)
    }
    else if (stats.isFile()) {
      if (EXCLUDED_FILES.has(item) || item.endsWith('.log'))
        continue
      if (shouldInclude(rel, deps))
        out.push(rel)
    }
  }
}

const TEXT_EXTENSIONS = new Set(['', '.ts', '.js', '.json', '.html', '.xml', '.gradle', '.properties', '.plist', '.pbxproj', '.xcconfig', '.swift', '.java', '.kt', '.strings', '.storyboard', '.xcscheme', '.resolved', '.lock', '.md', '.txt', '.pro'])

function isText(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  const ext = base.includes('.') ? `.${base.split('.').pop()}` : ''
  return TEXT_EXTENSIONS.has(ext)
}

function main() {
  if (!existsSync(join(templateDir, 'node_modules/@capacitor/ios')))
    fail('node_modules missing: run "bun install" in templates/website-live-app')

  const deps = nativePackages()
  const files: string[] = []
  walk(templateDir, deps, files)

  const zip = new AdmZip()
  const contents = new Map<string, Buffer>()
  for (const file of files)
    contents.set(file, readFileSync(join(templateDir, file)))

  // Web copies and the Cordova plugins module are not committed: `cap sync` generates them.
  for (const required of ['ios/App/App/public/index.html', 'android/app/src/main/assets/public/index.html', 'android/capacitor-cordova-android-plugins/build.gradle']) {
    if (!contents.has(required))
      fail(`${required} missing: run "bunx cap sync" in templates/website-live-app`)
  }

  // The builder may only parse JSON configs (same reasoning as the CLI): ship a resolved one.
  const androidConfig = JSON.parse(readText('android/app/src/main/assets/capacitor.config.json'))
  delete androidConfig.packageClassList
  contents.set(RESOLVED_CONFIG_PATH, Buffer.from(`${JSON.stringify(androidConfig, null, 2)}\n`, 'utf-8'))

  for (const required of [IOS_ICON_PATH, ...Object.values(ANDROID_ICON_PATHS), ...CAPACITOR_CONFIG_PATHS]) {
    if (!contents.has(required))
      fail(`required file missing from archive: ${required}`)
  }

  const byPlaceholder: Record<keyof typeof PLACEHOLDERS, string[]> = { bundleId: [], appName: [], websiteUrl: [] }
  const textFilesWithPlaceholders: string[] = []
  for (const [path, data] of [...contents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Plugin sources are never patched; only the app project files are.
    if (path.startsWith('node_modules/') || !isText(path))
      continue
    const text = data.toString('utf-8')
    let hit = false
    for (const [key, value] of Object.entries(PLACEHOLDERS) as [keyof typeof PLACEHOLDERS, string][]) {
      if (text.includes(value)) {
        byPlaceholder[key].push(path)
        hit = true
      }
    }
    if (hit)
      textFilesWithPlaceholders.push(path)
  }

  const manifest = {
    bundleId: PLACEHOLDERS.bundleId,
    appName: PLACEHOLDERS.appName,
    websiteUrl: PLACEHOLDERS.websiteUrl,
    iosIconPath: IOS_ICON_PATH,
    androidIconPaths: ANDROID_ICON_PATHS,
    capacitorConfigPaths: CAPACITOR_CONFIG_PATHS,
    textFilesWithPlaceholders,
    placeholderFiles: byPlaceholder,
    androidNamespace: 'app.capgo.websitelive',
    nativePackages: { ios: [...deps.ios].sort(), android: [...deps.android].sort() },
  }
  contents.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf-8'))

  for (const [path, data] of [...contents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    zip.addFile(path, data)
    const entry = zip.getEntry(path)
    if (entry) {
      entry.header.time = FIXED_DATE
      // Keep executables (gradlew) executable after extraction.
      if (path === 'android/gradlew')
        entry.attr = (0o100755 << 16) >>> 0
    }
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, zip.toBuffer())
  const size = statSync(outPath).size
  console.log(`Wrote ${relative(repoRoot, outPath)}: ${contents.size} files, ${(size / 1024 / 1024).toFixed(2)} MB (${size} bytes)`)
  console.log(`Native packages: ios=[${manifest.nativePackages.ios.join(', ')}] android=[${manifest.nativePackages.android.join(', ')}]`)
  console.log(`Files with placeholders: ${textFilesWithPlaceholders.length}`)
}

main()
