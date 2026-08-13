// src/build/prescan/gradle.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Parse android/gradle.properties into a key→value map (ignores comments/blank lines). */
export function gradleProperties(projectDir: string): Record<string, string> {
  const raw = readTextIfExists(join(projectDir, 'android', 'gradle.properties'))
  const out: Record<string, string> = {}
  if (!raw)
    return out
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('//'))
      continue
    const eq = t.indexOf('=')
    if (eq > 0)
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return out
}

/** Count `include ':…'` modules in android/capacitor.settings.gradle (proxy for plugin module count). */
export function settingsGradleModuleCount(projectDir: string): number {
  const raw = readTextIfExists(join(projectDir, 'android', 'capacitor.settings.gradle'))
  if (!raw)
    return 0
  return (raw.match(/^\s*include\s+':/gm) ?? []).length
}

export function appBuildGradle(projectDir: string): string | null {
  return readTextIfExists(join(projectDir, 'android', 'app', 'build.gradle'))
    ?? readTextIfExists(join(projectDir, 'android', 'app', 'build.gradle.kts'))
}

export function gradleApplicationId(projectDir: string): string | null {
  const gradle = appBuildGradle(projectDir)
  if (!gradle)
    return null
  // Comment-strip first so a commented `// applicationId "x"` line is ignored.
  const m = stripGradleComments(gradle).match(/applicationId\s*[=( ]\s*["']([\w.]+)["']/)
  return m?.[1] ?? null
}

export interface EffectiveApplicationId {
  /** The resolved package name, or null when the base id is unknown. */
  packageName: string | null
  /**
   * True when a productFlavors block exists (or a flavor was requested) but the
   * effective applicationId for that flavor cannot be resolved unambiguously
   * from static parsing. Callers should NOT emit a blocking error in this case.
   */
  ambiguous: boolean
}

/**
 * Slice the body of the first `keyword { ... }` block via brace counting.
 * Returns null when the keyword/open-brace is absent. Self-contained here so
 * gradle.ts stays free of a dependency on the check modules.
 */
function braceBlockBody(source: string, keyword: string): string | null {
  const header = source.match(new RegExp(`(?:^|[\\s;{}])${keyword}\\s*\\{`))
  if (header?.index === undefined)
    return null
  const open = source.indexOf('{', header.index + header[0].length - 1)
  if (open === -1)
    return null
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{')
      depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0)
        return source.slice(open + 1, i)
    }
  }
  return null
}

/**
 * Return `source` with the first `keyword { ... }` block (header + braces)
 * removed. Used to excise the `productFlavors` block before an SDK-literal scan
 * so a per-flavor `minSdkVersion`/`targetSdkVersion` literal — which the active
 * build does not necessarily apply — never leaks into the resolved value.
 * Returns the source unchanged when the block is absent.
 */
function removeBraceBlock(source: string, keyword: string): string {
  const header = source.match(new RegExp(`(?:^|[\\s;{}])${keyword}\\s*\\{`))
  if (header?.index === undefined)
    return source
  const open = source.indexOf('{', header.index + header[0].length - 1)
  if (open === -1)
    return source
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{')
      depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0)
        return source.slice(0, header.index) + ' ' + source.slice(i + 1)
    }
  }
  // Unbalanced braces: drop from the keyword to end-of-source rather than risk
  // reading a flavor literal past a malformed block.
  return source.slice(0, header.index)
}

/** Slice the body of the named direct child (depth-1) block of a DSL block. */
function flavorBody(productFlavors: string, flavor: string): string | null {
  let depth = 0
  let segmentStart = 0
  for (let i = 0; i < productFlavors.length; i++) {
    const ch = productFlavors[i]
    if (ch === '{') {
      if (depth === 0) {
        const header = productFlavors.slice(segmentStart, i)
        const kts = header.match(/(?:create|register)\s*\(\s*["'](\w+)["']\s*\)\s*$/)
        const creating = header.match(/val\s+(\w+)\s+by\s+creating\s*$/)
        const groovy = header.match(/(?:^|[\s;}])(\w+)\s*$/)
        const name = kts?.[1] ?? creating?.[1] ?? groovy?.[1]
        if (name === flavor) {
          // Found the flavor header; slice its brace body.
          let inner = 0
          for (let j = i; j < productFlavors.length; j++) {
            if (productFlavors[j] === '{')
              inner++
            else if (productFlavors[j] === '}') {
              inner--
              if (inner === 0)
                return productFlavors.slice(i + 1, j)
            }
          }
          return null
        }
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
  return null
}

/**
 * Resolve the package name the build will actually upload, accounting for the
 * active product flavor's `applicationId` override / `applicationIdSuffix` on
 * top of defaultConfig. A store-access probe must target this final package,
 * not the unflavored defaultConfig id, or it 404s on a valid flavored upload.
 *
 * Returns `ambiguous: true` (and a best-effort packageName) when a flavored
 * build cannot be statically resolved, so the caller can downgrade rather than
 * emit a blocking error.
 */
export function resolveEffectiveApplicationId(projectDir: string, flavor?: string): EffectiveApplicationId {
  const base = gradleApplicationId(projectDir)
  const gradle = appBuildGradle(projectDir)
  const stripped = gradle === null ? null : stripGradleComments(gradle)
  const hasFlavorsBlock = stripped !== null && braceBlockBody(stripped, 'productFlavors') !== null

  // No flavor requested: only ambiguous if flavors exist (a default variant may
  // still carry a suffix we cannot attribute) — but with no selected flavor we
  // cannot know which variant uploads, so flag ambiguous to stay safe.
  if (!flavor) {
    if (hasFlavorsBlock)
      return { packageName: base, ambiguous: true }
    return { packageName: base, ambiguous: false }
  }

  // A flavor was requested but we cannot parse the productFlavors block.
  if (stripped === null)
    return { packageName: base, ambiguous: true }
  const flavorsBlock = braceBlockBody(stripped, 'productFlavors')
  if (flavorsBlock === null)
    return { packageName: base, ambiguous: true }
  const body = flavorBody(flavorsBlock, flavor)
  if (body === null)
    return { packageName: base, ambiguous: true }

  // Full applicationId override on the flavor wins outright.
  const override = body.match(/applicationId\s*[=( ]\s*["']([\w.]+)["']/)
  if (override)
    return { packageName: override[1], ambiguous: false }

  // applicationIdSuffix is appended to the base defaultConfig id.
  const suffix = body.match(/applicationIdSuffix\s*[=( ]\s*["']([\w.]+)["']/)
  if (suffix) {
    if (base === null)
      return { packageName: null, ambiguous: true }
    const sep = suffix[1].startsWith('.') ? '' : '.'
    return { packageName: base + sep + suffix[1], ambiguous: false }
  }

  // Flavor exists but neither overrides the id: it inherits the base id.
  return { packageName: base, ambiguous: false }
}

const SDK_DIMENSIONS = {
  minSdk: 'minSdkVersion',
  targetSdk: 'targetSdkVersion',
  compileSdk: 'compileSdkVersion',
} as const

export type SdkDimension = keyof typeof SDK_DIMENSIONS

/**
 * Remove block and line (`//`) comments from a Gradle source. Required because
 * gradleApplicationId / resolveSdk must not match commented declarations.
 * Conservative: line stripping cuts from `//` to end-of-line, so a `//` inside
 * a string literal trims that line's tail - acceptable for the presence/value
 * scans these helpers perform.
 */
export function stripGradleComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '')
}

/**
 * Parse android/variables.gradle `ext { name = <int> }` into a key->number map.
 * The canonical Capacitor template puts SDK literals here and app/build.gradle
 * only references rootProject.ext.*. Non-integer values are skipped.
 */
export function variablesGradle(projectDir: string): Record<string, number> {
  const raw = readTextIfExists(join(projectDir, 'android', 'variables.gradle'))
  const out: Record<string, number> = {}
  if (!raw)
    return out
  const stripped = stripGradleComments(raw)
  const extOpen = stripped.search(/\bext\s*\{/)
  // Scan the ext{...} body when present; otherwise scan the whole file.
  const body = extOpen === -1 ? stripped : sliceBraceBody(stripped, extOpen)
  for (const m of body.matchAll(/([A-Za-z_]\w*)\s*=\s*(\d+)\b/g))
    out[m[1]] = Number(m[2])
  return out
}

/** Slice the body of the first `{ ... }` starting at/after `from`. */
function sliceBraceBody(source: string, from: number): string {
  const open = source.indexOf('{', from)
  if (open === -1)
    return ''
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{')
      depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0)
        return source.slice(open + 1, i)
    }
  }
  return source.slice(open + 1)
}

/**
 * Resolve an SDK dimension: literal in comment-stripped app/build.gradle first,
 * then android/variables.gradle, then the manifest <uses-sdk>. Returns null
 * (skip the dimension) when unresolved so SDK checks agree on one source of
 * truth.
 *
 * The gradle literal scan excises the `productFlavors` block first. A flavor
 * routinely pins a per-flavor SDK literal (e.g. a legacy/wear flavor with a
 * lower minSdk) that the active build does not necessarily apply; reading the
 * first literal anywhere in the file would let that flavor value drive a false
 * blocking SDK error (minSdkCapacitor / targetSdkPlay). Excising productFlavors
 * keeps the android-level `compileSdkVersion` and the defaultConfig
 * `minSdkVersion`/`targetSdkVersion` (the values the build actually applies)
 * while ignoring per-flavor overrides.
 */
export function resolveSdk(projectDir: string, dim: SdkDimension): number | null {
  const key = SDK_DIMENSIONS[dim]
  const gradle = appBuildGradle(projectDir)
  if (gradle) {
    // matches `targetSdkVersion 33`, `targetSdkVersion = 33`, `targetSdk = 33`
    const base = key.replace(/Version$/, '')
    const re = new RegExp(`\\b(?:${key}|${base})\\s*[=\\s]\\s*(\\d+)\\b`)
    // Drop the productFlavors block so a per-flavor literal cannot win.
    const scope = removeBraceBlock(stripGradleComments(gradle), 'productFlavors')
    const m = scope.match(re)
    if (m)
      return Number(m[1])
  }
  const fromVars = variablesGradle(projectDir)[key]
  if (typeof fromVars === 'number')
    return fromVars
  const manifest = readTextIfExists(join(projectDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'))
  if (manifest) {
    // Strip XML comments first so a commented-out `<!-- <uses-sdk .../> -->`
    // does not win over the live element (mirrors the manifest checks, which
    // uniformly operate on a comment-stripped source).
    const stripped = manifest.replace(/<!--[\s\S]*?-->/g, ' ')
    const m = stripped.match(new RegExp(`android:${key}\\s*=\\s*"(\\d+)"`))
    if (m)
      return Number(m[1])
  }
  return null
}

/** Android module directories from android/capacitor.settings.gradle `projectDir` entries. */
export function capacitorPluginAndroidDirs(projectDir: string): string[] {
  const raw = readTextIfExists(join(projectDir, 'android', 'capacitor.settings.gradle'))
  if (!raw)
    return []
  const androidDir = join(projectDir, 'android')
  const dirs: string[] = []
  const re = /project\(':[^']+'\)\.projectDir\s*=\s*new File\('([^']+)'\)/g
  for (let m = re.exec(raw); m !== null; m = re.exec(raw))
    dirs.push(join(androidDir, m[1]))
  return dirs
}
