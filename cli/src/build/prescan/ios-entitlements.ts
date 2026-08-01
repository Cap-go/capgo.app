// src/build/prescan/ios-entitlements.ts
//
// Reader for the app's own entitlements file. The profile-side entitlements are
// parsed by mobileprovision-parser (MobileprovisionDetail.profileEntitlements);
// the entitlement checks compare the two. All readers are pure and never throw.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { findXcodeProject } from '../pbxproj-parser'
import { plistArrayStrings, plistBool, plistString } from './checks/ios-plist-read'
import { readTargetConfigs } from './ios-pbxsettings'

const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application'

function preferredSetting(configs: { name: string, settings: Record<string, string> }[], key: string): string | undefined {
  return configs.find(config => config.name === 'Release')?.settings[key]
    ?? configs.find(config => config.name === 'Debug')?.settings[key]
    ?? configs.find(config => config.settings[key] !== undefined)?.settings[key]
}

function configuredEntitlementsPath(projectDir: string, appId?: string): string | null | undefined {
  const pbxPath = findXcodeProject(projectDir)
  if (!pbxPath)
    return undefined
  let pbx: string
  try {
    pbx = readFileSync(pbxPath, 'utf8')
  }
  catch {
    return undefined
  }

  const appTargets = readTargetConfigs(pbx).filter(({ target }) => target.productType === APPLICATION_PRODUCT_TYPE)
  const selected = appTargets.find(({ target, configs }) =>
    target.bundleId === appId || configs.some(config => config.settings.PRODUCT_BUNDLE_IDENTIFIER === appId))
    ?? appTargets[0]
  const configured = selected ? preferredSetting(selected.configs, 'CODE_SIGN_ENTITLEMENTS') : undefined
  if (configured === undefined)
    return undefined

  const sourceRoot = dirname(dirname(pbxPath))
  const expanded = configured.replace(/\$\((?:SRCROOT|SOURCE_ROOT|PROJECT_DIR)\)|\$\{(?:SRCROOT|SOURCE_ROOT|PROJECT_DIR)\}/g, sourceRoot)
  if (/\$\([^)]+\)|\$\{[^}]+\}/.test(expanded))
    return null
  return isAbsolute(expanded) ? expanded : resolve(sourceRoot, expanded)
}

/**
 * Read the app target's CODE_SIGN_ENTITLEMENTS file, falling back to the
 * Capacitor-convention path only when that build setting is absent.
 */
export function readAppEntitlements(projectDir: string, appId?: string): { raw: string } | null {
  const configured = configuredEntitlementsPath(projectDir, appId)
  if (configured === null)
    return null
  const path = configured ?? join(projectDir, 'ios', 'App', 'App', 'App.entitlements')
  if (!existsSync(path))
    return null
  try {
    return { raw: readFileSync(path, 'utf8') }
  }
  catch {
    return null
  }
}

/** String entitlement value (e.g. aps-environment), or null when absent. */
export function entString(raw: string, key: string): string | null {
  return plistString(raw, key)
}

/** Array entitlement members (e.g. application-groups), or [] when absent. */
export function entArray(raw: string, key: string): string[] {
  return plistArrayStrings(raw, key)
}

/** Boolean entitlement (e.g. get-task-allow), or null when absent. */
export function entBool(raw: string, key: string): boolean | null {
  return plistBool(raw, key)
}
