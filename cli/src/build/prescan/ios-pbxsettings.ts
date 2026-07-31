// src/build/prescan/ios-pbxsettings.ts
//
// pbxproj scalar build-setting readers + the Info.plist `$(VAR)` resolver.
// Implemented standalone (not by mutating pbxproj-parser) so the existing
// signing pipeline stays untouched; reuses findSignableTargets/PbxTarget for the
// target shape.
//
// CRITICAL parser caveat: the block capture allows ONE level of nested braces
// (the `buildSettings = { ... }` dict), mirroring resolveBundleId. Array-valued
// settings (`LD_RUNPATH_SEARCH_PATHS = ( ... )`, `GCC_PREPROCESSOR_DEFINITIONS`)
// span parentheses/lines and are deliberately NOT captured — only single-line
// SCALAR keys are returned. Build-setting inheritance / xcconfig is not
// resolved: an ABSENT scalar means "unknown/inherited", which callers treat as
// "skip". Every function is pure and returns null/[]/{} on malformed input.

import type { PbxTarget } from '../pbxproj-parser'
import { findSignableTargets } from '../pbxproj-parser'

const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application'

export interface BuildConfig {
  name: string
  settings: Record<string, string>
  isProjectLevel: boolean
}

export interface TargetConfigs {
  target: PbxTarget
  configs: { name: string, settings: Record<string, string> }[]
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pull the inner text of a single `buildSettings = { ... }` dict (one nested
 * level). The outer block's name line lives outside this, captured separately.
 */
function buildSettingsBlock(configBlock: string): string {
  const m = configBlock.match(/buildSettings\s*=\s*\{([\s\S]*?)\n\s*\};/)
  return m?.[1] ?? ''
}

/** Parse single-line `KEY = "?VALUE"?;` scalar pairs; skip array/paren values. */
function parseScalarSettings(settingsText: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of settingsText.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+(?:\[[^\]]*\])?)\s*=\s*(.+?);\s*$/i)
    if (!m)
      continue
    const key = m[1]
    let value = m[2].trim()
    // Skip array-valued settings — `( ... )` opens a multi-line list whose
    // closing paren is not on this line; never treat it as a scalar.
    if (value.startsWith('('))
      continue
    // Strip a single pair of surrounding double quotes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

/** Each XCBuildConfiguration block's id, name, and scalar settings dict. */
function eachConfigBlock(pbxContent: string): { id: string, name: string, settings: Record<string, string> }[] {
  if (!pbxContent)
    return []
  const blockRe = /(\w+)\s*\/\*[^*]*\*\/\s*=\s*\{[^{}]*isa\s*=\s*XCBuildConfiguration;(?:[^{}]*\{[^}]*\})*[^}]*\}/g
  const out: { id: string, name: string, settings: Record<string, string> }[] = []
  for (const m of pbxContent.matchAll(blockRe)) {
    const block = m[0]
    const id = m[1]
    const nameMatch = block.match(/\bname\s*=\s*("[^"]*"|[^;\s]+)\s*;/)
    const name = nameMatch ? nameMatch[1].replace(/^"|"$/g, '') : ''
    out.push({ id, name, settings: parseScalarSettings(buildSettingsBlock(block)) })
  }
  return out
}

/** IDs of the configs referenced by the PBXProject's buildConfigurationList. */
function projectLevelConfigIds(pbxContent: string): Set<string> {
  // The PBXProject block nests `attributes = { TargetAttributes = { ... } }`,
  // so a generic non-greedy block capture would stop early. Anchor on the
  // `isa = PBXProject;` marker and read the first buildConfigurationList that
  // follows it (the project-level one).
  const listId = pbxContent.match(/isa\s*=\s*PBXProject;[\s\S]*?buildConfigurationList\s*=\s*(\w+)/)?.[1]
  if (!listId)
    return new Set()
  return configListIds(pbxContent, listId)
}

/** The build-config IDs listed inside a named XCConfigurationList block. */
function configListIds(pbxContent: string, listId: string): Set<string> {
  const listRe = new RegExp(`${escapeRegex(listId)}\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*isa\\s*=\\s*XCConfigurationList;[^}]*\\}`)
  const listBlock = pbxContent.match(listRe)?.[0]
  if (!listBlock)
    return new Set()
  const section = listBlock.match(/buildConfigurations\s*=\s*\(([^)]*)\)/)
  if (!section)
    return new Set()
  return new Set(Array.from(section[1].matchAll(/(\w+)/g), m => m[1]))
}

/**
 * Per-config build settings (Debug/Release/...) plus an isProjectLevel flag for
 * the configs referenced by the PBXProject configuration list.
 */
export function readBuildConfigs(pbxContent: string): BuildConfig[] {
  const projectIds = projectLevelConfigIds(pbxContent)
  return eachConfigBlock(pbxContent).map(c => ({
    name: c.name,
    settings: c.settings,
    isProjectLevel: projectIds.has(c.id),
  }))
}

/**
 * Release-preferred scalar lookup across every build config. Returns the value
 * from a config named Release if one carries the key, else the first config
 * that carries it (fallback), else null. SCALAR keys only.
 */
export function readBuildSetting(pbxContent: string, name: string): string | null {
  let fallback: string | null = null
  for (const c of eachConfigBlock(pbxContent)) {
    const v = c.settings[name]
    if (v === undefined)
      continue
    if (c.name === 'Release')
      return v
    if (fallback === null)
      fallback = v
  }
  return fallback
}

/**
 * If rawValue is EXACTLY one `$(VAR)` or `${VAR}` reference, substitute it via
 * readBuildSetting(VAR); otherwise return rawValue unchanged. When the variable
 * has no pbxproj match the raw `$()` string is returned so callers can treat a
 * still-unresolved reference as "skip / cannot judge". A value that merely
 * contains a `$()` among other text is left untouched (not a clean reference).
 */
export function resolvePlistValue(rawValue: string, pbxContent: string): string {
  const parenthesized = rawValue.match(/^\$\(([A-Z0-9_]+)\)$/i)
  const braced = rawValue.match(/^\$\{([A-Z0-9_]+)\}$/i)
  const variable = parenthesized?.[1] ?? braced?.[1]
  if (!variable)
    return rawValue
  return readBuildSetting(pbxContent, variable) ?? rawValue
}

/**
 * Per signable target, the full scalar settings dict of each of its configs.
 * Reuses findSignableTargets for the target identity and re-walks the native
 * target blocks to associate each target name with its configuration list.
 */
export function readTargetConfigs(pbxContent: string): TargetConfigs[] {
  if (!pbxContent)
    return []
  const targets = findSignableTargets(pbxContent)
  if (targets.length === 0)
    return []

  // name -> configurationList id, from the PBXNativeTarget blocks.
  const targetConfigListByName = new Map<string, string>()
  const targetRe = /\w+\s*\/\*[^*]*\*\/\s*=\s*\{[^}]*isa\s*=\s*PBXNativeTarget;[^}]*\}/g
  for (const tm of pbxContent.matchAll(targetRe)) {
    const block = tm[0]
    const nameMatch = block.match(/\bname\s*=\s*("[^"]*"|[^;\s]+)\s*;/)
    const listMatch = block.match(/buildConfigurationList\s*=\s*(\w+)/)
    if (!nameMatch || !listMatch)
      continue
    targetConfigListByName.set(nameMatch[1].replace(/^"|"$/g, ''), listMatch[1])
  }

  const allBlocks = eachConfigBlock(pbxContent)
  const blockById = new Map(allBlocks.map(b => [b.id, b]))

  return targets.map((target) => {
    const listId = targetConfigListByName.get(target.name)
    const ids = listId ? configListIds(pbxContent, listId) : new Set<string>()
    const configs = Array.from(ids)
      .map(id => blockById.get(id))
      .filter((b): b is NonNullable<typeof b> => b !== undefined)
      .map(b => ({ name: b.name, settings: b.settings }))
    return { target, configs }
  })
}

/** Lowest explicit iOS deployment target across project and application configs. */
export function readMinimumIosDeploymentTarget(pbxContent: string): number | null {
  const values: number[] = []
  const add = (raw: string | undefined): void => {
    if (raw === undefined)
      return
    const value = Number.parseFloat(raw)
    if (!Number.isNaN(value))
      values.push(value)
  }

  for (const config of readBuildConfigs(pbxContent)) {
    if (config.isProjectLevel)
      add(config.settings.IPHONEOS_DEPLOYMENT_TARGET)
  }
  for (const { target, configs } of readTargetConfigs(pbxContent)) {
    if (target.productType !== APPLICATION_PRODUCT_TYPE)
      continue
    for (const config of configs)
      add(config.settings.IPHONEOS_DEPLOYMENT_TARGET)
  }
  // Degraded/minimal pbxproj fixtures may omit the project/target linkage.
  // Preserve the old best-effort behavior when no scoped value was discoverable.
  if (values.length === 0) {
    for (const config of readBuildConfigs(pbxContent))
      add(config.settings.IPHONEOS_DEPLOYMENT_TARGET)
  }
  return values.length > 0 ? Math.min(...values) : null
}
