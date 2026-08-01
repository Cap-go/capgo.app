// src/build/prescan/checks/android-project.ts
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  appBuildGradle,
  gradleProperties,
  readTextIfExists,
  resolveSdk,
  settingsGradleModuleCount,
  stripGradleComments,
} from '../gradle'
import { readAndroidManifest, stripXmlComments } from '../manifest'
import { capacitorMajor } from '../capacitor-version'
import { willUploadToPlay } from '../upload-intent'

function hasCordovaPlugins(ctx: ScanContext): boolean {
  const pkgRaw = readTextIfExists(join(ctx.projectDir, 'package.json'))
  if (!pkgRaw)
    return false
  try {
    const deps = Object.keys((JSON.parse(pkgRaw).dependencies ?? {}) as Record<string, string>)
    return deps.some(d => d.startsWith('cordova-plugin-') || d.startsWith('@awesome-cordova-plugins/'))
  }
  catch {
    return false
  }
}

export const cordovaVarsPresent: PrescanCheck = {
  id: 'android/cordova-vars-present',
  platforms: ['android'],
  appliesTo: hasCordovaPlugins,
  async run(ctx): Promise<Finding[]> {
    const path = join(ctx.projectDir, 'android', 'capacitor-cordova-android-plugins', 'cordova.variables.gradle')
    if (existsSync(path))
      return []
    return [{
      id: 'android/cordova-vars-present',
      severity: 'error',
      title: 'cordova.variables.gradle is missing — the cloud build cannot compile your Cordova plugins',
      detail: 'This generated file is gitignored; `cap copy` does not create it, only `cap sync` does',
      fix: 'Run `npx cap sync android` before requesting the build',
    }]
  },
}

const MANY_MODULES = 30
const MIN_HEAP_MB_FOR_LARGE = 2048

function xmxMb(jvmargs: string | undefined): number | null {
  const m = jvmargs?.match(/-Xmx(\d+)([mMgG])/)
  if (!m)
    return null
  const n = Number.parseInt(m[1], 10)
  return /g/i.test(m[2]) ? n * 1024 : n
}

export const gradlePropsHeuristics: PrescanCheck = {
  id: 'android/gradle-props-heuristics',
  platforms: ['android'],
  async run(ctx): Promise<Finding[]> {
    const modules = settingsGradleModuleCount(ctx.projectDir)
    const props = gradleProperties(ctx.projectDir)
    const findings: Finding[] = []
    const parallel = props['org.gradle.parallel'] === 'true'

    if (modules > MANY_MODULES && !parallel) {
      findings.push({
        id: 'android/gradle-props-heuristics',
        severity: 'warning',
        title: `${modules} Gradle modules build serially — org.gradle.parallel is not enabled`,
        fix: 'Add `org.gradle.parallel=true` (and `org.gradle.caching=true`) to android/gradle.properties',
      })
    }
    if (parallel && props['org.gradle.workers.max'] === '1') {
      findings.push({
        id: 'android/gradle-props-heuristics',
        severity: 'warning',
        title: 'org.gradle.workers.max=1 makes org.gradle.parallel=true a no-op',
        fix: 'Remove the workers.max cap (or raise it) so parallel project execution can work',
      })
    }
    const heap = xmxMb(props['org.gradle.jvmargs'])
    if (modules > MANY_MODULES && heap !== null && heap < MIN_HEAP_MB_FOR_LARGE) {
      findings.push({
        id: 'android/gradle-props-heuristics',
        severity: 'warning',
        title: `Gradle heap -Xmx${heap}m is small for ${modules} modules — D8/R8 may stall or OOM`,
        fix: 'Raise org.gradle.jvmargs, e.g. `-Xmx4096m -XX:MaxMetaspaceSize=1024m`',
      })
    }
    return findings
  },
}

export const playSaJson: PrescanCheck = {
  id: 'android/play-sa-json',
  platforms: ['android'],
  appliesTo: ctx => Boolean(ctx.credentials?.PLAY_CONFIG_JSON),
  async run(ctx): Promise<Finding[]> {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(ctx.credentials!.PLAY_CONFIG_JSON, 'base64').toString('utf8'))
    }
    catch {
      parsed = undefined
    }
    // JSON.parse accepts scalars ('null', '42', '"x"') and arrays — none of which
    // are a service-account object, so guard before any property access.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [{
        id: 'android/play-sa-json',
        severity: 'error',
        title: 'PLAY_CONFIG_JSON does not decode to valid JSON',
        fix: 'Base64-encode the raw service-account .json file',
      }]
    }
    const sa = parsed as Record<string, unknown>
    if (sa.type !== 'service_account') {
      return [{
        id: 'android/play-sa-json',
        severity: 'error',
        title: 'PLAY_CONFIG_JSON is not a service-account key',
        detail: `type: ${String(sa.type)}`,
        fix: 'Create a service-account key in Google Cloud Console (IAM → Service Accounts → Keys)',
      }]
    }
    const missing = ['private_key', 'client_email'].filter(k => !sa[k])
    if (missing.length > 0) {
      return [{
        id: 'android/play-sa-json',
        severity: 'error',
        title: 'Service-account JSON is incomplete',
        detail: `missing: ${missing.join(', ')}`,
        fix: 'Re-download the key file — it must contain private_key and client_email',
      }]
    }
    return []
  },
}

/**
 * Brace-counted extraction of the body of the first `keyword { ... }` block.
 * A greedy regex would capture to the LAST `}` in the file, swallowing
 * buildTypes/dependencies/etc. into the flavor list.
 */
export function extractBraceBlock(source: string, keyword: string): string | null {
  const headerMatch = source.match(new RegExp(`(?:^|[\\s;{}])${keyword}\\s*\\{`))
  if (headerMatch?.index === undefined)
    return null
  const open = source.indexOf('{', headerMatch.index + headerMatch[0].length - 1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') {
      depth++
    }
    else if (source[i] === '}') {
      depth--
      if (depth === 0)
        return source.slice(open + 1, i)
    }
  }
  return null
}

/**
 * Names of the direct (depth-1) child blocks of a Gradle DSL block body.
 * Handles Groovy `demo { ... }` and Kotlin DSL `create("demo") { ... }`,
 * `register("demo") { ... }`, and `val demo by creating { ... }`.
 */
export function childBlockNames(block: string): string[] {
  const names: string[] = []
  let depth = 0
  let segmentStart = 0
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]
    if (ch === '{') {
      if (depth === 0) {
        const header = block.slice(segmentStart, i)
        const kts = header.match(/(?:create|register)\s*\(\s*["'](\w+)["']\s*\)\s*$/)
        const creating = header.match(/val\s+(\w+)\s+by\s+creating\s*$/)
        const groovy = header.match(/(?:^|[\s;}])(\w+)\s*$/)
        const name = kts?.[1] ?? creating?.[1] ?? groovy?.[1]
        if (name)
          names.push(name)
      }
      depth++
    }
    else if (ch === '}') {
      depth = Math.max(0, depth - 1)
      if (depth === 0)
        segmentStart = i + 1
    }
    else if (depth === 0 && (ch === '\n' || ch === ';')) {
      segmentStart = i + 1
    }
  }
  return names
}

export const flavorExists: PrescanCheck = {
  id: 'android/flavor-exists',
  platforms: ['android'],
  appliesTo: ctx => Boolean(ctx.androidFlavor),
  async run(ctx): Promise<Finding[]> {
    const gradle = appBuildGradle(ctx.projectDir)
    if (!gradle)
      return []
    const block = extractBraceBlock(gradle, 'productFlavors')
    if (block === null) {
      return [{
        id: 'android/flavor-exists',
        severity: 'error',
        title: `--android-flavor "${ctx.androidFlavor}" passed but build.gradle declares no productFlavors`,
        fix: 'Drop the flag or add the flavor to android/app/build.gradle',
      }]
    }
    const flavors = childBlockNames(block).filter(f => f !== 'dimension')
    // a productFlavors block exists but our parser got nothing out of it
    // (exotic DSL): skip rather than emit a false blocking error
    if (flavors.length === 0)
      return []
    if (!flavors.includes(ctx.androidFlavor!)) {
      return [{
        id: 'android/flavor-exists',
        severity: 'error',
        title: `Product flavor "${ctx.androidFlavor}" not found in build.gradle`,
        detail: `declared flavors: ${flavors.join(', ')}`,
        fix: 'Use one of the declared flavors or add the missing one',
      }]
    }
    return []
  },
}

export const agp8PackageAttr: PrescanCheck = {
  id: 'android/agp8-package-attr',
  platforms: ['android'],
  async run(ctx): Promise<Finding[]> {
    const manifest = readAndroidManifest(ctx.projectDir)
    const gradle = appBuildGradle(ctx.projectDir)
    if (!manifest || !gradle)
      return []
    // Strip XML comments before the package= scan, mirroring every sibling
    // manifest check: a commented-out `<!-- <manifest ... package="…"> -->`
    // migration leftover must NOT trip this blocker (AGP ignores comments).
    // `[^>]*` keeps the scan inside the single <manifest …> open tag (it cannot
    // cross a `>` into other markup). The namespace probe is comment-stripped
    // too so a commented `// namespace "…"` cannot fabricate the block condition.
    const stripped = stripXmlComments(manifest.raw)
    const hasPackageAttr = /<manifest[^>]*\spackage\s*=\s*"/.test(stripped)
    const hasNamespace = /namespace\s*[=( ]\s*["']/.test(stripGradleComments(gradle))
    if (hasPackageAttr && hasNamespace) {
      return [{
        id: 'android/agp8-package-attr',
        severity: 'error',
        title: 'AndroidManifest.xml still has a package= attribute — AGP 8+ fails the build',
        detail: 'build.gradle declares `namespace`, so the manifest attribute is forbidden',
        fix: 'Delete the package="…" attribute from android/app/src/main/AndroidManifest.xml',
      }]
    }
    return []
  },
}

/** Read android/app/build.gradle (or .kts) comment-stripped, or null when absent. */
function strippedAppGradle(projectDir: string): string | null {
  const gradle = appBuildGradle(projectDir)
  return gradle === null ? null : stripGradleComments(gradle)
}

export const applicationIdPresent: PrescanCheck = {
  id: 'android/applicationid-present',
  platforms: ['android'],
  appliesTo: ctx => appBuildGradle(ctx.projectDir) !== null,
  async run(ctx): Promise<Finding[]> {
    const gradle = strippedAppGradle(ctx.projectDir)
    if (gradle === null)
      return []
    // Live assignment: `applicationId "x"`, `applicationId = "x"`, `applicationId("x")`.
    if (/(?:^|[\s;{(])applicationId\s*[=(\s]\s*["'][\w.]+["']/.test(gradle))
      return []
    // Flavor-provided: a productFlavors block whose body references applicationId(Suffix).
    const flavorBlock = extractBraceBlock(gradle, 'productFlavors')
    if (flavorBlock !== null && /applicationId(?:Suffix)?/.test(flavorBlock))
      return []
    return [{
      id: 'android/applicationid-present',
      severity: 'error',
      title: 'No applicationId is declared in android/app/build.gradle',
      detail: 'Capacitor needs a defaultConfig (or per-flavor) applicationId to assemble the APK/AAB',
      fix: 'Add `applicationId "your.app.id"` to defaultConfig (or per flavor); it must match the Capacitor appId',
    }]
  },
}

export const capacitorBuildGradleApplied: PrescanCheck = {
  id: 'android/capacitor-build-gradle-applied',
  platforms: ['android'],
  appliesTo: ctx => appBuildGradle(ctx.projectDir) !== null,
  async run(ctx): Promise<Finding[]> {
    const gradle = strippedAppGradle(ctx.projectDir)
    if (gradle === null)
      return []
    const hasApply = /apply\s+from:\s*["']capacitor\.build\.gradle["']/.test(gradle)
    const fileExists = existsSync(join(ctx.projectDir, 'android', 'app', 'capacitor.build.gradle'))
    if (hasApply && fileExists)
      return []
    if (hasApply && !fileExists) {
      return [{
        id: 'android/capacitor-build-gradle-applied',
        severity: 'error',
        title: 'app/build.gradle applies capacitor.build.gradle but the file is missing',
        detail: 'This generated file is created by `cap sync`, not `cap copy`',
        fix: 'Run `npx cap sync android` to regenerate android/app/capacitor.build.gradle',
      }]
    }
    return [{
      id: 'android/capacitor-build-gradle-applied',
      severity: 'error',
      title: 'app/build.gradle never applies capacitor.build.gradle',
      detail: 'Without `apply from: "capacitor.build.gradle"` the Capacitor plugin dependencies are not wired in',
      fix: 'Run `npx cap sync android`; ensure app/build.gradle has `apply from: \'capacitor.build.gradle\'`',
    }]
  },
}

export const gradleWrapperPresent: PrescanCheck = {
  id: 'android/gradle-wrapper-present',
  platforms: ['android'],
  appliesTo: ctx => existsSync(join(ctx.projectDir, 'android')),
  async run(ctx): Promise<Finding[]> {
    const props = readTextIfExists(join(ctx.projectDir, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'))
    if (props === null) {
      return [{
        id: 'android/gradle-wrapper-present',
        severity: 'error',
        title: 'The Gradle wrapper is missing — android/gradle/wrapper/gradle-wrapper.properties not found',
        detail: 'The cloud builder runs `./gradlew`, which needs the committed wrapper',
        fix: 'Restore it: `npx cap sync android` or `gradle wrapper`; commit android/gradle/wrapper/ + android/gradlew',
      }]
    }
    if (!/^distributionUrl=\S+/m.test(props)) {
      return [{
        id: 'android/gradle-wrapper-present',
        severity: 'error',
        title: 'gradle-wrapper.properties has no distributionUrl — Gradle cannot bootstrap',
        fix: 'Add a distributionUrl line (e.g. via `gradle wrapper`) or re-run `npx cap sync android`',
      }]
    }
    return []
  },
}

/** Parse productFlavors and the flavor names our childBlockNames parser can extract. */
function parsedFlavors(projectDir: string): { gradle: string, block: string, flavors: string[] } | null {
  const gradle = strippedAppGradle(projectDir)
  if (gradle === null)
    return null
  const block = extractBraceBlock(gradle, 'productFlavors')
  if (block === null)
    return null
  const flavors = childBlockNames(block).filter(n => n !== 'dimension')
  if (flavors.length === 0)
    return null
  return { gradle, block, flavors }
}

export const flavorDimensions: PrescanCheck = {
  id: 'android/flavor-dimensions',
  platforms: ['android'],
  appliesTo: ctx => parsedFlavors(ctx.projectDir) !== null,
  async run(ctx): Promise<Finding[]> {
    const parsed = parsedFlavors(ctx.projectDir)
    if (parsed === null)
      return []
    // A top-level flavorDimensions declaration covers every flavor.
    if (/flavorDimensions?\s*[=(\s]\s*["']/.test(parsed.gradle))
      return []
    const missing = parsed.flavors.filter((name) => {
      const body = extractBraceBlock(parsed.block, name)
      return body === null || !/(?:^|[\s;{])dimension\s+["']/.test(body)
    })
    if (missing.length === 0)
      return []
    return [{
      id: 'android/flavor-dimensions',
      severity: 'error',
      title: 'Product flavors are missing a dimension and no top-level flavorDimensions is declared',
      detail: `flavors without a dimension: ${missing.join(', ')}`,
      fix: 'Add `flavorDimensions "default"` and give every flavor `dimension "default"`',
    }]
  },
}

const GMS_APPLY_RE = /(?:apply\s+plugin:\s*["']com\.google\.gms\.google-services["']|id\s*[("']+com\.google\.gms\.google-services)/

/** True when a com.google.gms.google-services apply sits at brace depth 0 (unguarded). */
function hasUnguardedGmsApply(projectDir: string): boolean {
  const gradle = strippedAppGradle(projectDir)
  if (gradle === null)
    return false
  const m = gradle.match(GMS_APPLY_RE)
  if (m?.index === undefined)
    return false
  let depth = 0
  for (let i = 0; i < m.index; i++) {
    if (gradle[i] === '{')
      depth++
    else if (gradle[i] === '}')
      depth = Math.max(0, depth - 1)
  }
  return depth === 0
}

export const googleServicesFile: PrescanCheck = {
  id: 'android/google-services-file',
  platforms: ['android'],
  appliesTo: ctx => appBuildGradle(ctx.projectDir) !== null && hasUnguardedGmsApply(ctx.projectDir),
  async run(ctx): Promise<Finding[]> {
    if (existsSync(join(ctx.projectDir, 'android', 'app', 'google-services.json')))
      return []
    return [{
      id: 'android/google-services-file',
      severity: 'error',
      title: 'com.google.gms.google-services is applied unconditionally but google-services.json is missing',
      detail: 'The unguarded plugin apply fails the build when the config file is absent',
      fix: 'Supply android/app/google-services.json to the cloud build (it is gitignored), or guard/remove the gms apply',
    }]
  },
}

const LOCAL_PROP_RE = /^(sdk|ndk)\.dir\s*=\s*(.+)$/gm

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\\/.test(value)
}

export const localPropertiesCommitted: PrescanCheck = {
  id: 'android/local-properties-committed',
  platforms: ['android'],
  appliesTo: ctx => existsSync(join(ctx.projectDir, 'android', 'local.properties')),
  async run(ctx): Promise<Finding[]> {
    const raw = readTextIfExists(join(ctx.projectDir, 'android', 'local.properties'))
    if (raw === null)
      return []
    const findings: Finding[] = []
    for (const m of raw.matchAll(LOCAL_PROP_RE)) {
      const key = `${m[1]}.dir`
      if (isAbsolutePath(m[2].trim())) {
        // Echo only the KEY — never the absolute machine path.
        findings.push({
          id: 'android/local-properties-committed',
          severity: 'warning',
          title: 'android/local.properties is committed with a machine-specific SDK path',
          detail: `local.properties pins an absolute ${key}`,
          fix: 'Remove android/local.properties from VCS and gitignore it; the cloud builder sets its own SDK location',
        })
      }
    }
    return findings
  },
}

interface SdkFloor {
  dim: 'compileSdk' | 'targetSdk' | 'minSdk'
  label: string
  floor: number
}

const SDK_FLOORS: SdkFloor[] = [
  { dim: 'compileSdk', label: 'compileSdkVersion', floor: 34 },
  { dim: 'targetSdk', label: 'targetSdkVersion', floor: 34 },
  { dim: 'minSdk', label: 'minSdkVersion', floor: 23 },
]

export const sdkFloors: PrescanCheck = {
  id: 'android/sdk-floors',
  platforms: ['android'],
  appliesTo: ctx => SDK_FLOORS.some(({ dim }) => resolveSdk(ctx.projectDir, dim) !== null),
  async run(ctx): Promise<Finding[]> {
    const findings: Finding[] = []
    for (const { dim, label, floor } of SDK_FLOORS) {
      const value = resolveSdk(ctx.projectDir, dim)
      if (value === null || value >= floor)
        continue
      findings.push({
        id: 'android/sdk-floors',
        severity: 'warning',
        title: `${dim} ${value} is below the recommended floor (${floor})`,
        fix: `Raise ${label} to at least ${floor} in android/variables.gradle`,
      })
    }
    return findings
  },
}

// Hardcoded Play targetSdk policy. See https://developer.android.com/google/play/requirements/target-sdk
const PLAY_TARGET_MIN_AVAILABLE = 34
const PLAY_TARGET_MIN_SUBMIT = 35
const PLAY_TARGET_DOCS = 'https://developer.android.com/google/play/requirements/target-sdk'

export const targetSdkPlay: PrescanCheck = {
  id: 'android/target-sdk-play',
  platforms: ['android'],
  appliesTo: ctx => resolveSdk(ctx.projectDir, 'targetSdk') !== null,
  async run(ctx): Promise<Finding[]> {
    const target = resolveSdk(ctx.projectDir, 'targetSdk')
    if (target === null || target >= PLAY_TARGET_MIN_SUBMIT)
      return []
    if (target < PLAY_TARGET_MIN_AVAILABLE) {
      return [{
        id: 'android/target-sdk-play',
        severity: 'error',
        title: `targetSdk ${target} is below Play's minimum (${PLAY_TARGET_MIN_AVAILABLE}) — you cannot publish or stay available`,
        fix: `Set targetSdkVersion = ${PLAY_TARGET_MIN_SUBMIT} in android/variables.gradle`,
        docsUrl: PLAY_TARGET_DOCS,
      }]
    }
    // 34 <= target < 35: error when actually uploading, otherwise a warning.
    const uploading = willUploadToPlay(ctx)
    return [{
      id: 'android/target-sdk-play',
      severity: uploading ? 'error' : 'warning',
      title: `targetSdk ${target} is behind Play's submission requirement (${PLAY_TARGET_MIN_SUBMIT})`,
      detail: uploading
        ? 'Play rejects new apps and updates below this target'
        : 'Approaching enforcement — raise before your next submission',
      fix: `Set targetSdkVersion = ${PLAY_TARGET_MIN_SUBMIT} in android/variables.gradle`,
      docsUrl: PLAY_TARGET_DOCS,
    }]
  },
}

const CAP_MINSDK_FLOORS: Record<number, number> = { 6: 22, 7: 23, 8: 24 }
const CAP_MINSDK_DEFAULT = 24

function capacitorMinSdkFloor(major: number): number {
  return CAP_MINSDK_FLOORS[major] ?? CAP_MINSDK_DEFAULT
}

export const minSdkCapacitor: PrescanCheck = {
  id: 'android/min-sdk-capacitor',
  platforms: ['android'],
  appliesTo: ctx => capacitorMajor(ctx.projectDir) !== null && resolveSdk(ctx.projectDir, 'minSdk') !== null,
  async run(ctx): Promise<Finding[]> {
    const major = capacitorMajor(ctx.projectDir)
    const minSdk = resolveSdk(ctx.projectDir, 'minSdk')
    if (major === null || minSdk === null)
      return []
    const floor = capacitorMinSdkFloor(major)
    if (minSdk >= floor)
      return []
    return [{
      id: 'android/min-sdk-capacitor',
      severity: 'error',
      title: `minSdk ${minSdk} is below the Capacitor ${major} floor`,
      detail: `Capacitor ${major} requires minSdkVersion >= ${floor}`,
      fix: `Raise minSdkVersion to at least ${floor} in android/variables.gradle`,
    }]
  },
}

/** Whether app/build.gradle defaultConfig (comment-stripped) declares versionCode/versionName. */
function gradleVersionFields(projectDir: string): { code: boolean, name: boolean } {
  const gradle = strippedAppGradle(projectDir)
  if (gradle === null)
    return { code: false, name: false }
  // Accept a literal, variable, or function call after the keyword (don't require an int).
  // The `[=\s]` separator mirrors resolveSdk so the Kotlin-DSL assignment form
  // (`versionName = "1.0"`) is recognized, not just the Groovy form (`versionName "1.0"`).
  return {
    code: /versionCode\s*[=\s]\s*\S/.test(gradle),
    name: /versionName\s*[=\s]\s*["']/.test(gradle) || /versionName\s*[=\s]\s*\w/.test(gradle),
  }
}

function manifestVersionFields(projectDir: string): { code: boolean, name: boolean } {
  const manifest = readTextIfExists(join(projectDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'))
  if (manifest === null)
    return { code: false, name: false }
  return {
    code: /android:versionCode\s*=\s*"/.test(manifest),
    name: /android:versionName\s*=\s*"/.test(manifest),
  }
}

export const versionFields: PrescanCheck = {
  id: 'android/version-fields',
  platforms: ['android'],
  appliesTo: ctx => appBuildGradle(ctx.projectDir) !== null,
  async run(ctx): Promise<Finding[]> {
    const fromGradle = gradleVersionFields(ctx.projectDir)
    const fromManifest = manifestVersionFields(ctx.projectDir)
    const hasCode = fromGradle.code || fromManifest.code
    const hasName = fromGradle.name || fromManifest.name
    const findings: Finding[] = []
    if (!hasCode) {
      const uploading = willUploadToPlay(ctx)
      findings.push({
        id: 'android/version-fields',
        severity: uploading ? 'error' : 'warning',
        title: 'No versionCode found in app/build.gradle or AndroidManifest.xml',
        detail: uploading
          ? 'Google Play rejects an upload without an integer versionCode'
          : 'A versionCode is required to assemble a release artifact',
        fix: 'Set versionCode (integer) in android/app/build.gradle defaultConfig (or via the CLI build-number bump)',
      })
    }
    if (!hasName) {
      findings.push({
        id: 'android/version-fields',
        severity: 'warning',
        title: 'No versionName found in app/build.gradle or AndroidManifest.xml',
        fix: 'Set versionName in android/app/build.gradle defaultConfig',
      })
    }
    return findings
  },
}
