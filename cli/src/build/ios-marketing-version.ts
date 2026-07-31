import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
  changed: boolean
}

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

  const current = readFileSync(pbxprojPath, 'utf8')
  const { content, replacements } = replaceMarketingVersionInPbxproj(current, marketingVersion)

  if (replacements === 0) {
    throw new Error(`No MARKETING_VERSION entries found in ${pbxprojPath}`)
  }

  const changed = content !== current

  if (changed && !options.check) {
    writeFileSync(pbxprojPath, content, 'utf8')
  }

  return {
    projectDir,
    packageJsonPath,
    pbxprojPath,
    packageVersion,
    marketingVersion,
    replacements,
    changed,
  }
}

export function syncIosMarketingVersionCommand(options: SyncIosMarketingVersionOptions): void {
  try {
    const result = syncIosMarketingVersion(options)

    if (result.changed && options.check) {
      clackLog.error(`iOS MARKETING_VERSION is not synced with package version ${result.packageVersion}; expected ${result.marketingVersion}`)
      exit(1)
    }

    if (result.changed) {
      clackLog.success(`Updated ${result.replacements} iOS MARKETING_VERSION entries to ${result.marketingVersion}`)
      return
    }

    clackLog.success(`iOS MARKETING_VERSION is already ${result.marketingVersion}`)
  }
  catch (error) {
    clackLog.error(error instanceof Error ? error.message : String(error))
    exit(1)
  }
}
