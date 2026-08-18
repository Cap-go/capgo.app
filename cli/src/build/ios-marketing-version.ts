import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { exit } from 'node:process'
import { log as clackLog } from '@clack/prompts'
import { findXcodeProject } from './pbxproj-parser'

export interface SyncIosMarketingVersionOptions {
  path?: string
  check?: boolean
}

export interface SyncIosMarketingVersionResult {
  projectDir: string
  packageJsonPath: string
  pbxprojPath: string
  packageVersion: string
  marketingVersion: string
  replacements: number
  updatedFiles: string[]
  changed: boolean
}

interface FileUpdate {
  path: string
  content: string
  replacements: number
}

const INFO_PLIST_VERSION_KEY = 'CFBundleShortVersionString'
const MARKETING_VERSION_REFERENCE = '$(MARKETING_VERSION)'

export function deriveIosMarketingVersion(packageVersion: string): string {
  const marketingVersion = packageVersion.split(/[+-]/)[0]

  if (!/^\d+\.\d+\.\d+$/.test(marketingVersion)) {
    throw new Error(`Cannot derive an iOS MARKETING_VERSION from package version "${packageVersion}"`)
  }

  return marketingVersion
}

export function replaceMarketingVersionInPbxproj(content: string, marketingVersion: string): { content: string, replacements: number } {
  let replacements = 0

  const updated = content.replace(/(\bMARKETING_VERSION\s*=\s*)[^;]+(\s*;)/g, (_match, prefix: string, suffix: string) => {
    replacements += 1
    return `${prefix}${marketingVersion}${suffix}`
  })

  return { content: updated, replacements }
}

function readBuildSettingValues(content: string, setting: string): string[] {
  const values: string[] = []
  const settingRegex = new RegExp(`\\b${setting}\\s*=\\s*(?:"([^"]*)"|([^;]+))\\s*;`, 'g')

  for (const match of content.matchAll(settingRegex))
    values.push((match[1] ?? match[2] ?? '').trim())

  return values
}

function resolveInfoPlistPath(pbxprojPath: string, settingValue: string): string {
  const sourceRoot = dirname(dirname(pbxprojPath))
  const expanded = settingValue
    .replace(/^\$\((?:SRCROOT|PROJECT_DIR)\)\/?/, '')
    .replace(/^\$\{(?:SRCROOT|PROJECT_DIR)\}\/?/, '')

  if (/\$\([^)]+\)|\$\{[^}]+\}/.test(expanded)) {
    throw new Error(`Cannot resolve INFOPLIST_FILE path "${settingValue}" in ${pbxprojPath}`)
  }

  return isAbsolute(expanded) ? expanded : resolve(sourceRoot, expanded)
}

function replaceInfoPlistVersion(content: string, marketingVersion: string): { content: string, replacements: number } {
  const entryRegex = new RegExp(`(<key>${INFO_PLIST_VERSION_KEY}<\\/key>\\s*<string>)([\\s\\S]*?)(<\\/string>)`)
  const entry = content.match(entryRegex)

  if (entry) {
    if (entry[2].trim() === marketingVersion)
      return { content, replacements: 0 }

    return {
      content: content.replace(entryRegex, (_match, prefix: string, _currentValue: string, suffix: string) => `${prefix}${marketingVersion}${suffix}`),
      replacements: 1,
    }
  }

  if (content.includes(`<key>${INFO_PLIST_VERSION_KEY}</key>`)) {
    throw new Error(`${INFO_PLIST_VERSION_KEY} must be a string in Info.plist`)
  }

  const closingDictIndex = content.lastIndexOf('</dict>')
  if (closingDictIndex === -1)
    throw new Error('Cannot add CFBundleShortVersionString to malformed Info.plist: missing </dict>')

  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const closingLineStart = content.lastIndexOf(newline, closingDictIndex - 1) + newline.length
  const closingIndent = content.slice(closingLineStart, closingDictIndex).match(/^[\t ]*/)?.[0] ?? ''
  const entryIndent = `${closingIndent}\t`
  const entryContent = `${entryIndent}<key>${INFO_PLIST_VERSION_KEY}</key>${newline}${entryIndent}<string>${marketingVersion}</string>${newline}`

  return {
    content: `${content.slice(0, closingLineStart)}${entryContent}${content.slice(closingLineStart)}`,
    replacements: 1,
  }
}

export function syncIosMarketingVersion(options: SyncIosMarketingVersionOptions = {}): SyncIosMarketingVersionResult {
  const projectDir = resolve(options.path ?? process.cwd())
  const packageJsonPath = join(projectDir, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string }
  const packageVersion = packageJson.version

  if (!packageVersion) {
    throw new Error(`${packageJsonPath} is missing version`)
  }

  const marketingVersion = deriveIosMarketingVersion(packageVersion)
  const pbxprojPath = findXcodeProject(projectDir)

  if (!pbxprojPath) {
    throw new Error(`No Xcode project.pbxproj found under ${projectDir}`)
  }

  const pbxprojContent = readFileSync(pbxprojPath, 'utf8')
  const generateInfoPlistValues = readBuildSettingValues(pbxprojContent, 'GENERATE_INFOPLIST_FILE')
  const hasGeneratedInfoPlist = generateInfoPlistValues.some(value => value.toUpperCase() === 'YES')
  const hasManualInfoPlist = generateInfoPlistValues.length === 0
    || generateInfoPlistValues.some(value => value.toUpperCase() !== 'YES')
  let shouldUpdateMarketingVersion = hasGeneratedInfoPlist
  const updates: FileUpdate[] = []

  if (hasManualInfoPlist) {
    const infoPlistPaths = [...new Set(
      readBuildSettingValues(pbxprojContent, 'INFOPLIST_FILE')
        .map(value => resolveInfoPlistPath(pbxprojPath, value)),
    )]

    if (infoPlistPaths.length === 0)
      throw new Error(`No INFOPLIST_FILE entries found in ${pbxprojPath}`)

    for (const infoPlistPath of infoPlistPaths) {
      if (!existsSync(infoPlistPath))
        throw new Error(`Info.plist not found at ${infoPlistPath}`)

      const infoPlistContent = readFileSync(infoPlistPath, 'utf8')
      const versionEntry = infoPlistContent.match(new RegExp(`<key>${INFO_PLIST_VERSION_KEY}<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`))

      if (versionEntry?.[1].trim() === MARKETING_VERSION_REFERENCE) {
        shouldUpdateMarketingVersion = true
        continue
      }

      const infoPlistUpdate = replaceInfoPlistVersion(infoPlistContent, marketingVersion)
      if (infoPlistUpdate.content !== infoPlistContent) {
        updates.push({
          path: infoPlistPath,
          content: infoPlistUpdate.content,
          replacements: infoPlistUpdate.replacements,
        })
      }
    }
  }

  if (shouldUpdateMarketingVersion) {
    const pbxprojUpdate = replaceMarketingVersionInPbxproj(pbxprojContent, marketingVersion)
    if (pbxprojUpdate.replacements === 0)
      throw new Error(`No MARKETING_VERSION entries found in ${pbxprojPath}`)
    if (pbxprojUpdate.content !== pbxprojContent) {
      updates.push({
        path: pbxprojPath,
        content: pbxprojUpdate.content,
        replacements: pbxprojUpdate.replacements,
      })
    }
  }

  if (!options.check) {
    for (const update of updates)
      writeFileSync(update.path, update.content, 'utf8')
  }

  const updatedFiles = updates.map(update => update.path)
  const replacements = updates.reduce((total, update) => total + update.replacements, 0)
  const changed = updatedFiles.length > 0

  return {
    projectDir,
    packageJsonPath,
    pbxprojPath,
    packageVersion,
    marketingVersion,
    replacements,
    updatedFiles,
    changed,
  }
}

export function syncIosMarketingVersionCommand(options: SyncIosMarketingVersionOptions): void {
  try {
    const result = syncIosMarketingVersion(options)

    if (result.changed && options.check) {
      clackLog.error(`iOS app version is not synced with package version ${result.packageVersion}; expected ${result.marketingVersion}`)
      exit(1)
    }

    if (result.changed) {
      clackLog.success(`Updated iOS app version to ${result.marketingVersion} in ${result.updatedFiles.length} file(s)`)
      return
    }

    clackLog.success(`iOS app version is already ${result.marketingVersion}`)
  }
  catch (error) {
    clackLog.error(error instanceof Error ? error.message : String(error))
    exit(1)
  }
}
