// src/build/prescan/checks/ios-plist.ts
import type { Finding, PrescanCheck } from '../types'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { plistString } from './ios-plist-read'

// RFC 3986/1738 scheme grammar - no underscores. Exported so the Android
// deep-link check (manifest.ts re-exports this) validates schemes with the
// exact same grammar as the iOS Info.plist scheme check.
export const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/i
const PURPOSE_KEYS = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSContactsUsageDescription',
  'NSFaceIDUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
]
const PLACEHOLDERS = new Set(['', 'todo', 'tbd', 'description', 'usage description', 'lorem ipsum'])

export const infoplistSanity: PrescanCheck = {
  id: 'ios/infoplist-sanity',
  platforms: ['ios'],
  async run(ctx): Promise<Finding[]> {
    const plistPath = join(ctx.projectDir, 'ios', 'App', 'App', 'Info.plist')
    if (!existsSync(plistPath))
      return []
    const raw = readFileSync(plistPath, 'utf8')
    const findings: Finding[] = []

    // Presence-only by design (deliberate deviation from the spec's "present+literal"):
    // modern Xcode templates set these to $(CURRENT_PROJECT_VERSION)/$(MARKETING_VERSION)
    // build-setting references, which resolve fine at build time — flagging them
    // would false-positive on perfectly valid projects.
    if (!raw.includes('<key>CFBundleVersion</key>')) {
      findings.push({ id: 'ios/infoplist-sanity', severity: 'warning', title: 'Info.plist has no CFBundleVersion', fix: 'Add CFBundleVersion (build number) — App Store uploads require it' })
    }
    if (!raw.includes('<key>CFBundleShortVersionString</key>')) {
      findings.push({ id: 'ios/infoplist-sanity', severity: 'warning', title: 'Info.plist has no CFBundleShortVersionString', fix: 'Add the marketing version (e.g. 1.0.0)' })
    }

    // URL schemes: collect every <string> inside CFBundleURLSchemes arrays
    const schemesBlocks = raw.match(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g) ?? []
    for (const block of schemesBlocks) {
      for (const m of block.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
        const scheme = m[1].trim()
        if (scheme && !SCHEME_RE.test(scheme)) {
          findings.push({
            id: 'ios/infoplist-sanity',
            severity: 'error',
            title: `Invalid URL scheme "${scheme}" — App Store upload will reject it`,
            detail: 'Schemes must match RFC 3986: letters, digits, "+", "-", "." only (no underscores)',
            fix: 'Rename the scheme (e.g. replace "_" with "-") in Info.plist and your deep-link config',
          })
        }
      }
    }

    for (const key of PURPOSE_KEYS) {
      if (!raw.includes(`<key>${key}</key>`))
        continue
      const value = plistString(raw, key)
      if (value === null || PLACEHOLDERS.has(value.trim().toLowerCase()) || value.trim().length < 8) {
        findings.push({
          id: 'ios/infoplist-sanity',
          severity: 'warning',
          title: `${key} is empty or placeholder text`,
          fix: 'App Review rejects vague purpose strings — describe the actual user-facing reason',
        })
      }
    }
    return findings
  },
}
