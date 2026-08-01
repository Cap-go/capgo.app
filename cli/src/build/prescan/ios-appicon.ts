// src/build/prescan/ios-appicon.ts
//
// Reader for the AppIcon asset-catalog Contents.json. Contents.json is real
// JSON, so JSON.parse (in try/catch) is the parse-safety net — readContentsJson
// NEVER throws (null on missing/malformed). The other helpers are pure.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBuildSetting } from './ios-pbxsettings'

export interface AppIconImage {
  idiom?: string
  size?: string
  scale?: string
  filename?: string
  platform?: string
  role?: string
}

export interface AssetContents {
  images?: AppIconImage[]
  info?: { version?: number, author?: string }
}

/**
 * Parse an asset-catalog Contents.json. Returns null on a missing file OR a
 * parse error — the asset catalog is the one place an invalid hand-edit can
 * crash a naive reader, so this is the shared safety net for the appicon checks.
 * Never throws.
 */
export function readContentsJson(path: string): AssetContents | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AssetContents
  }
  catch {
    return null
  }
}

/**
 * Absolute path to the project's `<IconName>.appiconset` directory. The icon
 * name comes from the pbxproj ASSETCATALOG_COMPILER_APPICON_NAME build setting
 * (Release-preferred) and defaults to `AppIcon` for standard Capacitor layouts.
 */
export function appIconSetDir(projectDir: string, pbxContent?: string): string {
  const iconName = (pbxContent ? readBuildSetting(pbxContent, 'ASSETCATALOG_COMPILER_APPICON_NAME') : null) ?? 'AppIcon'
  return join(projectDir, 'ios', 'App', 'App', 'Assets.xcassets', `${iconName}.appiconset`)
}

function normalizeSize(size: string | undefined): string {
  return (size ?? '').trim()
}

/**
 * Whether the icon set declares the App Store marketing icon: a `1024x1024`
 * size (whitespace-trimmed) or an image whose `role` is `marketing`.
 */
export function hasMarketingIcon(c: AssetContents | null): boolean {
  return (c?.images ?? []).some(i => normalizeSize(i.size) === '1024x1024' || i.role === 'marketing')
}
