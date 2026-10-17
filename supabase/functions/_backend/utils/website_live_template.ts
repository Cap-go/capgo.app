import type { WebsiteLiveIconSet } from './website_live_icons.ts'
import { deflateSync, inflateSync } from 'fflate'
import { simpleError } from './hono.ts'

/**
 * Patch the packed Web2App native template (scripts/pack-website-live-template.ts) for one app.
 *
 * The zip is rewritten entry by entry: untouched entries are copied as raw compressed bytes
 * (byte-identical data, original method, CRC, timestamps and unix modes such as gradlew's 0755),
 * and only patched files are inflated / deflated. This keeps CPU low on Workers and keeps the
 * file attributes that fflate's unzipSync does not expose.
 */

export interface WebsiteLiveTemplateManifest {
  bundleId: string
  appName: string
  websiteUrl: string
  iosIconPath: string
  androidIconPaths: {
    launcher: string
    launcherRound: string
    launcherForeground: string
    backgroundColor?: string
  }
  capacitorConfigPaths: string[]
  textFilesWithPlaceholders: string[]
  placeholderFiles?: Partial<Record<'bundleId' | 'appName' | 'websiteUrl', string[]>>
  /** Android Java/Kotlin namespace; a prefix of the bundle id placeholder that must stay untouched. */
  androidNamespace?: string
  nativePackages?: { ios: string[], android: string[] }
}

export interface WebsiteLiveTemplateInput {
  bundleId: string
  appName: string
  websiteUrl: string
  capgoAppId: string
  /** semver x.y.z */
  versionName: string
  versionCode: number
  icons: WebsiteLiveIconSet
}

export const WEBSITE_LIVE_MANIFEST_PATH = 'manifest.json'
const DEFAULT_ANDROID_BACKGROUND_PATH = 'android/app/src/main/res/values/ic_launcher_background.xml'
const ANDROID_BUILD_GRADLE_PATHS = ['android/app/build.gradle', 'android/app/build.gradle.kts']

// Reverse-DNS valid for both stores: Android forbids hyphens and segments starting with a digit.
const BUNDLE_ID_REGEX = /^[a-z]\w*(?:\.[a-z]\w*)+$/i
const CAPGO_APP_ID_REGEX = /^[a-z0-9]+(?:\.[\w-]+)+$/i
const VERSION_NAME_REGEX = /^\d+\.\d+\.\d+$/

/** True for C0/C1 control characters and the JS line/paragraph separators. */
export function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1F || (code >= 0x7F && code <= 0x9F) || code === 0x2028 || code === 0x2029)
      return true
  }
  return false
}
const MAX_VERSION_CODE = 2_100_000_000

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateWebsiteLiveTemplateInput(input: Omit<WebsiteLiveTemplateInput, 'icons'>) {
  const { bundleId, appName, websiteUrl, capgoAppId, versionName, versionCode } = input
  if (typeof bundleId !== 'string' || bundleId.length > 155 || !BUNDLE_ID_REGEX.test(bundleId))
    throw simpleError('invalid_bundle_id', 'Bundle id must be reverse-DNS (letters, digits, underscores; each segment starts with a letter; no hyphens)', { bundleId })
  if (typeof capgoAppId !== 'string' || capgoAppId.length > 255 || !CAPGO_APP_ID_REGEX.test(capgoAppId))
    throw simpleError('invalid_capgo_app_id', 'Capgo app id is invalid', { capgoAppId })
  const nameLength = typeof appName === 'string' ? [...appName].length : 0
  if (typeof appName !== 'string' || nameLength < 1 || nameLength > 30 || appName.trim() === '' || hasControlCharacters(appName))
    throw simpleError('invalid_app_name', 'App name must be 1-30 characters without control characters', { appName })
  let url: URL | null = null
  try {
    url = typeof websiteUrl === 'string' && websiteUrl.length <= 2048 ? new URL(websiteUrl) : null
  }
  catch {
    url = null
  }
  if (!url || url.protocol !== 'https:' || hasControlCharacters(websiteUrl))
    throw simpleError('invalid_website_url', 'Website URL must be a valid https:// URL', { websiteUrl })
  if (typeof versionName !== 'string' || !VERSION_NAME_REGEX.test(versionName))
    throw simpleError('invalid_version_name', 'Version name must be x.y.z', { versionName })
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE)
    throw simpleError('invalid_version_code', `Version code must be an integer between 1 and ${MAX_VERSION_CODE}`, { versionCode })
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0)
}

export function parseWebsiteLiveTemplateManifest(raw: string): WebsiteLiveTemplateManifest {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw simpleError('invalid_template_manifest', 'Template manifest.json is not valid JSON', {}, error)
  }
  const icons = parsed?.androidIconPaths
  const valid = parsed && typeof parsed === 'object'
    && typeof parsed.bundleId === 'string' && parsed.bundleId
    && typeof parsed.appName === 'string' && parsed.appName
    && typeof parsed.websiteUrl === 'string' && parsed.websiteUrl
    && typeof parsed.iosIconPath === 'string' && parsed.iosIconPath
    && icons && typeof icons === 'object'
    && typeof icons.launcher === 'string' && typeof icons.launcherRound === 'string' && typeof icons.launcherForeground === 'string'
    && (icons.backgroundColor === undefined || typeof icons.backgroundColor === 'string')
    && isStringArray(parsed.capacitorConfigPaths)
    && isStringArray(parsed.textFilesWithPlaceholders)
    && (parsed.androidNamespace === undefined || typeof parsed.androidNamespace === 'string')
  if (!valid)
    throw simpleError('invalid_template_manifest', 'Template manifest.json is missing required fields')
  return parsed as WebsiteLiveTemplateManifest
}

// ---------------------------------------------------------------------------
// Zip reading / writing with raw passthrough
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  nameBytes: Uint8Array
  versionMadeBy: number
  versionNeeded: number
  flags: number
  method: number
  time: number
  date: number
  crc: number
  compressedSize: number
  size: number
  internalAttrs: number
  externalAttrs: number
  /** Raw (possibly compressed) data. */
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++)
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = -1
  for (let i = 0; i < data.length; i++)
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function invalidTemplate(message: string): never {
  throw simpleError('invalid_template', message)
}

function readZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xFFFF); i--) {
    if (view.getUint32(i, true) === 0x06054B50) {
      eocd = i
      break
    }
  }
  if (eocd < 0)
    invalidTemplate('Template is not a zip archive')
  const count = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (count === 0xFFFF || cdOffset === 0xFFFFFFFF)
    invalidTemplate('Zip64 templates are not supported')
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== 0x02014B50)
      invalidTemplate('Template zip central directory is corrupt')
    const flags = view.getUint16(p + 8, true)
    if (flags & 1)
      invalidTemplate('Encrypted template entries are not supported')
    const compressedSize = view.getUint32(p + 20, true)
    const size = view.getUint32(p + 24, true)
    const nameLength = view.getUint16(p + 28, true)
    const extraLength = view.getUint16(p + 30, true)
    const commentLength = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    const nameBytes = zip.subarray(p + 46, p + 46 + nameLength)
    if (localOffset + 30 > zip.length || view.getUint32(localOffset, true) !== 0x04034B50)
      invalidTemplate('Template zip local header is corrupt')
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    if (dataStart + compressedSize > zip.length)
      invalidTemplate('Template zip entry is truncated')
    entries.push({
      name: decoder.decode(nameBytes),
      nameBytes,
      versionMadeBy: view.getUint16(p + 4, true),
      versionNeeded: view.getUint16(p + 6, true),
      flags,
      method: view.getUint16(p + 10, true),
      time: view.getUint16(p + 12, true),
      date: view.getUint16(p + 14, true),
      crc: view.getUint32(p + 16, true),
      compressedSize,
      size,
      internalAttrs: view.getUint16(p + 36, true),
      externalAttrs: view.getUint32(p + 38, true),
      data: zip.subarray(dataStart, dataStart + compressedSize),
    })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function entryContent(entry: ZipEntry): Uint8Array {
  if (entry.method === 0)
    return entry.data
  if (entry.method === 8) {
    try {
      return inflateSync(entry.data, { out: new Uint8Array(entry.size) })
    }
    catch (error) {
      throw simpleError('invalid_template', `Template entry ${entry.name} cannot be inflated`, {}, error)
    }
  }
  return invalidTemplate(`Template entry ${entry.name} uses unsupported compression ${entry.method}`)
}

const STORED_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|jar|zip|gz|aar)$/i
// 2020-01-01 00:00, same fixed timestamp the pack script uses.
const DEFAULT_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1

function setEntryContent(entry: ZipEntry, content: Uint8Array) {
  let data = content
  let method = 0
  if (!STORED_EXTENSIONS.test(entry.name) && content.length > 0) {
    const deflated = deflateSync(content, { level: 6 })
    if (deflated.length < content.length) {
      data = deflated
      method = 8
    }
  }
  entry.data = data
  entry.method = method
  entry.compressedSize = data.length
  entry.size = content.length
  entry.crc = crc32(content)
  entry.flags &= 0x0800 // keep only the UTF-8 name flag; sizes are written in the local header
  entry.versionNeeded = Math.max(20, entry.versionNeeded & 0xFF)
}

function newEntry(name: string): ZipEntry {
  const nameBytes = new TextEncoder().encode(name)
  return {
    name,
    nameBytes,
    versionMadeBy: (3 << 8) | 20,
    versionNeeded: 20,
    flags: nameBytes.length !== name.length ? 0x0800 : 0,
    method: 0,
    time: 0,
    date: DEFAULT_DOS_DATE,
    crc: 0,
    compressedSize: 0,
    size: 0,
    internalAttrs: 0,
    externalAttrs: (0o100644 << 16) >>> 0,
    data: new Uint8Array(0),
  }
}

function writeZip(entries: ZipEntry[]): Uint8Array {
  let total = 22
  for (const e of entries)
    total += 30 + e.nameBytes.length + e.data.length + 46 + e.nameBytes.length
  if (total > 0xFFFFFFFF || entries.length > 0xFFFF)
    invalidTemplate('Patched template is too large')
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  const offsets: number[] = []
  let p = 0
  for (const e of entries) {
    offsets.push(p)
    view.setUint32(p, 0x04034B50, true)
    view.setUint16(p + 4, e.versionNeeded, true)
    view.setUint16(p + 6, e.flags & ~0x0008, true)
    view.setUint16(p + 8, e.method, true)
    view.setUint16(p + 10, e.time, true)
    view.setUint16(p + 12, e.date, true)
    view.setUint32(p + 14, e.crc, true)
    view.setUint32(p + 18, e.compressedSize, true)
    view.setUint32(p + 22, e.size, true)
    view.setUint16(p + 26, e.nameBytes.length, true)
    view.setUint16(p + 28, 0, true)
    out.set(e.nameBytes, p + 30)
    p += 30 + e.nameBytes.length
    out.set(e.data, p)
    p += e.data.length
  }
  const cdStart = p
  entries.forEach((e, i) => {
    view.setUint32(p, 0x02014B50, true)
    view.setUint16(p + 4, e.versionMadeBy, true)
    view.setUint16(p + 6, e.versionNeeded, true)
    view.setUint16(p + 8, e.flags & ~0x0008, true)
    view.setUint16(p + 10, e.method, true)
    view.setUint16(p + 12, e.time, true)
    view.setUint16(p + 14, e.date, true)
    view.setUint32(p + 16, e.crc, true)
    view.setUint32(p + 20, e.compressedSize, true)
    view.setUint32(p + 24, e.size, true)
    view.setUint16(p + 28, e.nameBytes.length, true)
    // extra, comment, disk start: 0
    view.setUint16(p + 36, e.internalAttrs, true)
    view.setUint32(p + 38, e.externalAttrs, true)
    view.setUint32(p + 42, offsets[i], true)
    out.set(e.nameBytes, p + 46)
    p += 46 + e.nameBytes.length
  })
  view.setUint32(p, 0x06054B50, true)
  view.setUint16(p + 8, entries.length, true)
  view.setUint16(p + 10, entries.length, true)
  view.setUint32(p + 12, p - cdStart, true)
  view.setUint32(p + 16, cdStart, true)
  return out
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Android string resources: aapt escapes on top of XML escaping. */
function escapeAndroidResource(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/"/g, '\\"').replace(/^([@?])/, '\\$1')
  return escaped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeJsLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, '\\\'').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

function escapeGradle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, '\\\'').replace(/\$/g, '\\$')
}

function escaperFor(path: string): (value: string) => string {
  const lower = path.toLowerCase()
  if (/\/res\/values[^/]*\/[^/]+\.xml$/.test(lower))
    return escapeAndroidResource
  if (/\.(?:plist|xml|storyboard|xib|xcscheme|html?)$/.test(lower))
    return escapeXml
  if (/\.(?:json|resolved)$/.test(lower))
    return escapeJsonString
  if (/\.(?:ts|js|mjs|cjs)$/.test(lower))
    return escapeJsLike
  if (/\.gradle(?:\.kts)?$/.test(lower))
    return escapeGradle
  if (/\.(?:pbxproj|strings|swift|xcconfig)$/.test(lower))
    return escapeQuoted
  return value => value
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exact-token replacement: never touch a longer identifier that merely starts with the placeholder. */
function replaceBundleId(text: string, placeholder: string, value: string): string {
  return text.replace(new RegExp(`${escapeRegExp(placeholder)}(?![\\w.-])`, 'g'), value)
}

function replacePlaceholders(text: string, path: string, manifest: WebsiteLiveTemplateManifest, input: WebsiteLiveTemplateInput): string {
  const escape = escaperFor(path)
  let out = text.replaceAll(manifest.websiteUrl, escape(input.websiteUrl))
  out = replaceBundleId(out, manifest.bundleId, escape(input.bundleId))
  out = out.replaceAll(manifest.appName, escape(input.appName))
  return out
}

function patchConfigTree(node: unknown, manifest: WebsiteLiveTemplateManifest, input: WebsiteLiveTemplateInput): unknown {
  if (Array.isArray(node))
    return node.map(item => patchConfigTree(item, manifest, input))
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node))
      out[key] = patchConfigTree(value, manifest, input)
    return out
  }
  if (typeof node === 'string') {
    if (node === manifest.websiteUrl)
      return input.websiteUrl
    if (node === manifest.bundleId)
      return input.bundleId
    if (node === manifest.appName)
      return input.appName
  }
  return node
}

function patchCapacitorJson(text: string, path: string, manifest: WebsiteLiveTemplateManifest, input: WebsiteLiveTemplateInput): string {
  let config: any
  try {
    config = JSON.parse(text)
  }
  catch (error) {
    throw simpleError('template_patch_failed', `Template ${path} is not valid JSON`, { path }, error)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw simpleError('template_patch_failed', `Template ${path} is not a JSON object`, { path })
  // Locates the website URL wherever the updater plugin keeps it, whatever the key name.
  const patched = patchConfigTree(config, manifest, input) as Record<string, any>
  patched.appId = input.bundleId
  patched.appName = input.appName
  const updater = patched.plugins?.CapacitorUpdater
  if (updater && typeof updater === 'object')
    updater.appId = input.capgoAppId
  const indent = /\n(\s+)"/.exec(text)?.[1] ?? '  '
  return `${JSON.stringify(patched, null, indent)}${text.endsWith('\n') ? '\n' : ''}`
}

function patchCapacitorTs(text: string, path: string, manifest: WebsiteLiveTemplateManifest, input: WebsiteLiveTemplateInput): string {
  const placeholder = escapeRegExp(manifest.bundleId)
  // CapacitorUpdater.appId is the Capgo app id, the rest of the bundle id occurrences are the native id.
  const updaterAppId = new RegExp(`(CapacitorUpdater\\s*:\\s*\\{[^}]*?\\bappId\\s*:\\s*)(['"\`])${placeholder}\\2`)
  const withUpdater = text.replace(updaterAppId, (_m, prefix: string, quote: string) => `${prefix}${quote}${escapeJsLike(input.capgoAppId)}${quote}`)
  return replacePlaceholders(withUpdater, path, manifest, input)
}

function patchPbxproj(text: string, path: string, input: WebsiteLiveTemplateInput): string {
  let marketing = 0
  let build = 0
  const out = text
    .replace(/(\bMARKETING_VERSION\s*=\s*)[^;\s][^;\n]*;/g, (_m, prefix: string) => {
      marketing++
      return `${prefix}${input.versionName};`
    })
    .replace(/(\bCURRENT_PROJECT_VERSION\s*=\s*)[^;\s][^;\n]*;/g, (_m, prefix: string) => {
      build++
      return `${prefix}${input.versionCode};`
    })
  if (!marketing || !build)
    throw simpleError('template_patch_failed', 'MARKETING_VERSION / CURRENT_PROJECT_VERSION not found in project.pbxproj', { path })
  return out
}

function patchBuildGradle(text: string, path: string, input: WebsiteLiveTemplateInput): string {
  let code = 0
  let name = 0
  const out = text
    .replace(/(\bversionCode\s*(?:=\s*)?)\d+/g, (_m, prefix: string) => {
      code++
      return `${prefix}${input.versionCode}`
    })
    .replace(/(\bversionName\s*(?:=\s*)?)(["'])[^"'\n]*\2/g, (_m, prefix: string, quote: string) => {
      name++
      return `${prefix}${quote}${input.versionName}${quote}`
    })
  if (!code || !name)
    throw simpleError('template_patch_failed', 'versionCode / versionName not found in Android build.gradle', { path })
  return out
}

function backgroundColorXml(existing: string | null, color: string): string {
  if (existing && /<color\s+name="ic_launcher_background"\s*>[^<]*<\/color>/.test(existing))
    return existing.replace(/(<color\s+name="ic_launcher_background"\s*>)[^<]*(<\/color>)/, `$1${color}$2`)
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${color}</color>\n</resources>\n`
}

export function patchWebsiteLiveTemplate(templateZip: Uint8Array, input: WebsiteLiveTemplateInput): Uint8Array {
  validateWebsiteLiveTemplateInput(input)
  if (!input.icons || !(input.icons.ios1024 instanceof Uint8Array))
    throw simpleError('invalid_icon', 'Icon set is required')

  const entries = readZip(templateZip)
  const byName = new Map(entries.map(entry => [entry.name, entry]))
  const manifestEntry = byName.get(WEBSITE_LIVE_MANIFEST_PATH)
  if (!manifestEntry)
    throw simpleError('invalid_template_manifest', 'Template manifest.json is missing')

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  const manifest = parseWebsiteLiveTemplateManifest(decoder.decode(entryContent(manifestEntry)))

  const requireEntry = (path: string): ZipEntry => {
    const entry = byName.get(path)
    if (!entry)
      throw simpleError('template_file_missing', `Template file ${path} is missing`, { path })
    return entry
  }
  const readText = (entry: ZipEntry): string => {
    try {
      return decoder.decode(entryContent(entry))
    }
    catch (error) {
      throw simpleError('template_patch_failed', `Template file ${entry.name} is not UTF-8 text`, { path: entry.name }, error)
    }
  }
  // Text patches accumulate here so a file listed in several places is patched in sequence.
  const texts = new Map<string, string>()
  const getText = (path: string) => texts.get(path) ?? readText(requireEntry(path))

  const configPaths = new Set(manifest.capacitorConfigPaths)
  for (const path of manifest.capacitorConfigPaths) {
    const text = getText(path)
    texts.set(path, path.endsWith('.json')
      ? patchCapacitorJson(text, path, manifest, input)
      : path.endsWith('.ts') || path.endsWith('.js')
        ? patchCapacitorTs(text, path, manifest, input)
        : replacePlaceholders(text, path, manifest, input))
  }
  for (const path of manifest.textFilesWithPlaceholders) {
    if (configPaths.has(path))
      continue
    texts.set(path, replacePlaceholders(getText(path), path, manifest, input))
  }

  const pbxprojPaths = entries
    .map(e => e.name)
    .filter(name => name.startsWith('ios/') && name.endsWith('.xcodeproj/project.pbxproj'))
  if (!pbxprojPaths.length)
    throw simpleError('template_file_missing', 'Template iOS project.pbxproj is missing', { path: 'ios/**/*.xcodeproj/project.pbxproj' })
  for (const path of pbxprojPaths)
    texts.set(path, patchPbxproj(getText(path), path, input))

  const gradlePath = ANDROID_BUILD_GRADLE_PATHS.find(path => byName.has(path))
  if (!gradlePath)
    throw simpleError('template_file_missing', 'Template android/app/build.gradle is missing', { path: ANDROID_BUILD_GRADLE_PATHS[0] })
  texts.set(gradlePath, patchBuildGradle(getText(gradlePath), gradlePath, input))

  // Safety net: no bundle id / app name placeholder may survive in the listed files.
  for (const [path, text] of texts) {
    const leftoverBundle = !input.bundleId.includes(manifest.bundleId) && new RegExp(`${escapeRegExp(manifest.bundleId)}(?![\\w.-])`).test(text)
    const leftoverName = !input.appName.includes(manifest.appName) && text.includes(manifest.appName)
    if (leftoverBundle || leftoverName)
      throw simpleError('template_patch_failed', `Placeholder left in ${path} after patching`, { path })
  }

  const binaries = new Map<string, Uint8Array>([
    [manifest.iosIconPath, input.icons.ios1024],
    [manifest.androidIconPaths.launcher, input.icons.androidLegacy192],
    [manifest.androidIconPaths.launcherRound, input.icons.androidRound192],
    [manifest.androidIconPaths.launcherForeground, input.icons.androidForeground432],
  ])
  for (const path of binaries.keys())
    requireEntry(path)

  const backgroundPath = manifest.androidIconPaths.backgroundColor || DEFAULT_ANDROID_BACKGROUND_PATH
  const backgroundEntry = byName.get(backgroundPath)
  const color = /^#[0-9a-f]{6}$/i.test(input.icons.backgroundColor) ? input.icons.backgroundColor.toUpperCase() : '#FFFFFF'
  texts.set(backgroundPath, backgroundColorXml(backgroundEntry ? getText(backgroundPath) : null, color))

  const output: ZipEntry[] = []
  for (const entry of entries) {
    if (entry.name === WEBSITE_LIVE_MANIFEST_PATH)
      continue
    const text = texts.get(entry.name)
    const binary = binaries.get(entry.name)
    if (text !== undefined)
      setEntryContent(entry, encoder.encode(text))
    else if (binary !== undefined)
      setEntryContent(entry, binary)
    output.push(entry)
  }
  if (!backgroundEntry) {
    const entry = newEntry(backgroundPath)
    setEntryContent(entry, encoder.encode(texts.get(backgroundPath)!))
    output.push(entry)
  }
  return writeZip(output)
}
