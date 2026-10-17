import type { WebsiteLiveIconSet } from '../supabase/functions/_backend/utils/website_live_icons.ts'
import type { WebsiteLiveTemplateInput } from '../supabase/functions/_backend/utils/website_live_template.ts'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decode, encode } from 'fast-png'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { generateWebsiteLiveIconSet } from '../supabase/functions/_backend/utils/website_live_icons.ts'
import { patchWebsiteLiveTemplate } from '../supabase/functions/_backend/utils/website_live_template.ts'

const BUNDLE = 'app.capgo.websitelive.template'
const NAME = 'Web2App Template'
const URL_PLACEHOLDER = 'https://example.com'
const NAMESPACE = 'app.capgo.websitelive'

const ICON_PATHS = {
  ios: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
  launcher: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
  launcherRound: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png',
  launcherForeground: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png',
  background: 'android/app/src/main/res/values/ic_launcher_background.xml',
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn()
  }
  catch (error) {
    return (error as { cause?: { error?: string } }).cause?.error
  }
  return undefined
}

let cachedIcons: WebsiteLiveIconSet | undefined
function icons(): WebsiteLiveIconSet {
  if (!cachedIcons) {
    const size = 512
    const data = new Uint8Array(size * size * 4).fill(200)
    cachedIcons = generateWebsiteLiveIconSet(encode({ width: size, height: size, data, channels: 4, depth: 8 }), { backgroundColor: '#abcdef' })
  }
  return cachedIcons
}

function input(overrides: Partial<WebsiteLiveTemplateInput> = {}): WebsiteLiveTemplateInput {
  return {
    bundleId: 'com.example.shop',
    appName: 'Tom & Jerry\'s <App>',
    websiteUrl: 'https://shop.example.org/?a=1&b="2"',
    capgoAppId: 'com.example.shop-capgo',
    versionName: '2.3.4',
    versionCode: 42,
    icons: icons(),
    ...overrides,
  }
}

const GRADLEW = '#!/bin/sh\necho gradle\n'
const PNG_PLACEHOLDER = encode({ width: 1, height: 1, data: new Uint8Array(4), channels: 4, depth: 8 })

function capConfig(indent: string | number) {
  return `${JSON.stringify({
    appId: BUNDLE,
    appName: NAME,
    webDir: 'www',
    plugins: {
      CapacitorUpdater: { appId: BUNDLE, websiteMode: true, autoUpdate: true },
      SomeWebsitePlugin: { nested: [{ startUrl: URL_PLACEHOLDER }] },
    },
  }, null, indent)}\n`
}

function buildTemplate(options: { omit?: string[], manifest?: Record<string, unknown> } = {}): Uint8Array {
  const files: Record<string, string | Uint8Array> = {
    'capacitor.config.ts': `const config = {\n  appId: '${BUNDLE}',\n  appName: '${NAME}',\n  plugins: {\n    CapacitorUpdater: {\n      appId: '${BUNDLE}',\n      websiteMode: true,\n    },\n  },\n}\nexport default config\n`,
    'capacitor.config.json': capConfig(2),
    'ios/App/App/capacitor.config.json': capConfig('\t'),
    'android/app/src/main/assets/capacitor.config.json': capConfig(2),
    'ios/App/App.xcodeproj/project.pbxproj': `\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE};\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0.0;\n`,
    'ios/App/App/Info.plist': `<plist><dict>\n\t<key>CFBundleDisplayName</key>\n\t<string>${NAME}</string>\n</dict></plist>\n`,
    'ios/App/App/public/index.html': `<title>${NAME}</title><meta name="capgo-website-url" content="${URL_PLACEHOLDER}" />`,
    'android/app/build.gradle': `android {\n    namespace "${NAMESPACE}"\n    defaultConfig {\n        applicationId "${BUNDLE}"\n        versionCode 1\n        versionName "1.0.0"\n    }\n}\n`,
    'android/app/src/main/res/values/strings.xml': `<resources>\n    <string name="app_name">${NAME}</string>\n    <string name="package_name">${BUNDLE}</string>\n</resources>\n`,
    'android/app/src/main/java/app/capgo/websitelive/MainActivity.java': `package ${NAMESPACE};\n`,
    [ICON_PATHS.ios]: PNG_PLACEHOLDER,
    [ICON_PATHS.launcher]: PNG_PLACEHOLDER,
    [ICON_PATHS.launcherRound]: PNG_PLACEHOLDER,
    [ICON_PATHS.launcherForeground]: PNG_PLACEHOLDER,
    [ICON_PATHS.background]: '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n',
  }
  const manifest = {
    bundleId: BUNDLE,
    appName: NAME,
    websiteUrl: URL_PLACEHOLDER,
    iosIconPath: ICON_PATHS.ios,
    androidIconPaths: {
      launcher: ICON_PATHS.launcher,
      launcherRound: ICON_PATHS.launcherRound,
      launcherForeground: ICON_PATHS.launcherForeground,
      backgroundColor: ICON_PATHS.background,
    },
    capacitorConfigPaths: ['capacitor.config.ts', 'capacitor.config.json', 'ios/App/App/capacitor.config.json', 'android/app/src/main/assets/capacitor.config.json'],
    textFilesWithPlaceholders: [
      'android/app/build.gradle',
      'android/app/src/main/res/values/strings.xml',
      'capacitor.config.json',
      'ios/App/App.xcodeproj/project.pbxproj',
      'ios/App/App/Info.plist',
      'ios/App/App/public/index.html',
    ],
    androidNamespace: NAMESPACE,
    ...options.manifest,
  }
  const zippable: Parameters<typeof zipSync>[0] = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'android/gradlew': [strToU8(GRADLEW), { os: 3, attrs: (0o100755 << 16) >>> 0 }],
  }
  for (const [path, content] of Object.entries(files)) {
    if (options.omit?.includes(path))
      continue
    zippable[path] = [typeof content === 'string' ? strToU8(content) : content, { os: 3, attrs: (0o100644 << 16) >>> 0 }]
  }
  return zipSync(zippable)
}

/** Unix mode and raw (compressed) data per entry, read from the central directory. */
function rawEntries(zip: Uint8Array): Map<string, { mode: number, method: number, raw: Uint8Array }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (view.getUint32(eocd, true) !== 0x06054B50)
    eocd--
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const entries = new Map<string, { mode: number, method: number, raw: Uint8Array }>()
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(p + 28, true)
    const name = strFromU8(zip.subarray(p + 46, p + 46 + nameLength))
    const local = view.getUint32(p + 42, true)
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    entries.set(name, {
      mode: view.getUint32(p + 38, true) >>> 16,
      method: view.getUint16(p + 10, true),
      raw: zip.subarray(dataStart, dataStart + view.getUint32(p + 20, true)),
    })
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
  }
  return entries
}

describe('website live template patching', () => {
  it('patches every placeholder with the right escaping', () => {
    const template = buildTemplate()
    const original = unzipSync(template)
    const patched = patchWebsiteLiveTemplate(template, input())
    const files = unzipSync(patched)
    const text = (path: string) => strFromU8(files[path])

    expect(files['manifest.json']).toBeUndefined()

    for (const path of ['capacitor.config.json', 'ios/App/App/capacitor.config.json', 'android/app/src/main/assets/capacitor.config.json']) {
      const config = JSON.parse(text(path))
      expect(config.appId).toBe('com.example.shop')
      expect(config.appName).toBe('Tom & Jerry\'s <App>')
      expect(config.plugins.CapacitorUpdater.appId).toBe('com.example.shop-capgo')
      expect(config.plugins.SomeWebsitePlugin.nested[0].startUrl).toBe('https://shop.example.org/?a=1&b="2"')
    }
    expect(text('ios/App/App/capacitor.config.json')).toContain('\n\t"appId"')

    const ts = text('capacitor.config.ts')
    expect(ts).toContain('appId: \'com.example.shop\',\n  appName: \'Tom & Jerry\\\'s <App>\'')
    expect(ts).toContain('CapacitorUpdater: {\n      appId: \'com.example.shop-capgo\'')

    expect(text('ios/App/App/Info.plist')).toContain('<string>Tom &amp; Jerry&apos;s &lt;App&gt;</string>')
    expect(text('ios/App/App/public/index.html')).toBe('<title>Tom &amp; Jerry&apos;s &lt;App&gt;</title><meta name="capgo-website-url" content="https://shop.example.org/?a=1&amp;b=&quot;2&quot;" />')
    const strings = text('android/app/src/main/res/values/strings.xml')
    expect(strings).toContain('<string name="app_name">Tom &amp; Jerry\\\'s &lt;App&gt;</string>')
    expect(strings).toContain('<string name="package_name">com.example.shop</string>')

    const pbx = text('ios/App/App.xcodeproj/project.pbxproj')
    expect(pbx.match(/MARKETING_VERSION = 2\.3\.4;/g)).toHaveLength(2)
    expect(pbx.match(/CURRENT_PROJECT_VERSION = 42;/g)).toHaveLength(2)
    expect(pbx).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.example.shop;')

    const gradle = text('android/app/build.gradle')
    expect(gradle).toContain('applicationId "com.example.shop"')
    expect(gradle).toContain(`namespace "${NAMESPACE}"`)
    expect(gradle).toContain('versionCode 42')
    expect(gradle).toContain('versionName "2.3.4"')
    expect(text('android/app/src/main/java/app/capgo/websitelive/MainActivity.java')).toBe(`package ${NAMESPACE};\n`)

    expect(text(ICON_PATHS.background)).toContain('<color name="ic_launcher_background">#ABCDEF</color>')
    const iconChecks: [string, number, number][] = [
      [ICON_PATHS.ios, 1024, 3],
      [ICON_PATHS.launcher, 192, 3],
      [ICON_PATHS.launcherRound, 192, 4],
      [ICON_PATHS.launcherForeground, 432, 4],
    ]
    for (const [path, size, channels] of iconChecks) {
      const png = decode(files[path])
      expect([png.width, png.height, png.channels]).toEqual([size, size, channels])
    }

    expect(files['android/gradlew']).toEqual(original['android/gradlew'])
    const modes = rawEntries(patched)
    expect(modes.get('android/gradlew')?.mode).toBe(0o100755)
    expect(modes.get('android/app/build.gradle')?.mode).toBe(0o100644)
  })

  it('copies untouched entries as raw compressed bytes', () => {
    const template = buildTemplate()
    const before = rawEntries(template)
    const after = rawEntries(patchWebsiteLiveTemplate(template, input()))
    for (const path of ['android/gradlew', 'android/app/src/main/java/app/capgo/websitelive/MainActivity.java']) {
      expect(after.get(path)?.method, path).toBe(before.get(path)?.method)
      expect(after.get(path)!.raw, path).toEqual(before.get(path)!.raw)
    }
  })

  it('creates the background color resource when missing', () => {
    const template = buildTemplate({ omit: [ICON_PATHS.background], manifest: { androidIconPaths: { launcher: ICON_PATHS.launcher, launcherRound: ICON_PATHS.launcherRound, launcherForeground: ICON_PATHS.launcherForeground } } })
    const files = unzipSync(patchWebsiteLiveTemplate(template, input()))
    expect(strFromU8(files[ICON_PATHS.background])).toContain('#ABCDEF')
  })

  it('fails with typed errors for missing files and bad manifests', () => {
    expect(errorCode(() => patchWebsiteLiveTemplate(buildTemplate({ omit: ['ios/App/App/Info.plist'] }), input()))).toBe('template_file_missing')
    expect(errorCode(() => patchWebsiteLiveTemplate(buildTemplate({ omit: [ICON_PATHS.launcherRound] }), input()))).toBe('template_file_missing')
    expect(errorCode(() => patchWebsiteLiveTemplate(buildTemplate({ manifest: { iosIconPath: 3 } }), input()))).toBe('invalid_template_manifest')
    expect(errorCode(() => patchWebsiteLiveTemplate(new Uint8Array(100), input()))).toBe('invalid_template')
  })

  it('validates inputs', () => {
    const template = buildTemplate()
    const cases: [Partial<WebsiteLiveTemplateInput>, string][] = [
      [{ bundleId: 'com.my-app.shop' }, 'invalid_bundle_id'],
      [{ bundleId: 'com.1app' }, 'invalid_bundle_id'],
      [{ bundleId: 'single' }, 'invalid_bundle_id'],
      [{ appName: '' }, 'invalid_app_name'],
      [{ appName: 'a'.repeat(31) }, 'invalid_app_name'],
      [{ appName: 'Bad\nName' }, 'invalid_app_name'],
      [{ websiteUrl: 'http://insecure.example.com' }, 'invalid_website_url'],
      [{ websiteUrl: 'not a url' }, 'invalid_website_url'],
      [{ versionName: '1.0' }, 'invalid_version_name'],
      [{ versionCode: 0 }, 'invalid_version_code'],
      [{ versionCode: 2_100_000_001 }, 'invalid_version_code'],
      [{ versionCode: 1.5 }, 'invalid_version_code'],
      [{ capgoAppId: 'bad id' }, 'invalid_capgo_app_id'],
    ]
    for (const [override, code] of cases)
      expect(errorCode(() => patchWebsiteLiveTemplate(template, input(override))), code).toBe(code)
    expect(() => patchWebsiteLiveTemplate(template, input({ bundleId: 'com.my_app.Shop2', appName: 'a'.repeat(30) }))).not.toThrow()
  })

  const realZip = resolve(__dirname, '../dist/website-live-template.zip')
  it.skipIf(!existsSync(realZip))('patches the real packed template', () => {
    const template = new Uint8Array(readFileSync(realZip))
    const manifest = JSON.parse(strFromU8(unzipSync(template, { filter: f => f.name === 'manifest.json' })['manifest.json']))
    const start = performance.now()
    const patched = patchWebsiteLiveTemplate(template, input())
    console.log(`website live template patch: ${(performance.now() - start).toFixed(0)} ms, ${template.length} -> ${patched.length} bytes`)
    const files = unzipSync(patched)
    const original = unzipSync(template)
    expect(files['manifest.json']).toBeUndefined()
    expect(Object.keys(files).length).toBe(Object.keys(original).length - 1)
    expect(rawEntries(patched).get('android/gradlew')?.mode).toBe(0o100755)

    for (const [path, data] of Object.entries(files)) {
      if (path.startsWith('node_modules/') || /\.(?:png|jar)$/.test(path))
        continue
      const text = strFromU8(data)
      expect(text, path).not.toContain(BUNDLE)
      expect(text, path).not.toContain(NAME)
      expect(text, path).not.toContain(URL_PLACEHOLDER)
    }
    expect(strFromU8(files['android/app/build.gradle'])).toContain(manifest.androidNamespace)
    expect(JSON.parse(strFromU8(files['capacitor.config.json'])).plugins.CapacitorUpdater.appId).toBe('com.example.shop-capgo')
    expect(decode(files[manifest.iosIconPath]).width).toBe(1024)
  })
})
