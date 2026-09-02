import { intro, log } from '@clack/prompts'
import color from 'picocolors'
import { join } from 'node:path'
import {
  checkCompatibilityNativePackages,
  createSupabaseClient,
  findSavedKey,
  getCompatibilityDetails,
  isCompatible,
} from '@capgo/cli/sdk'
import { getReactNativeLocalDependencies, toNativePackages } from './metadata.js'

export interface CompatibilityOptions {
  project: string
  channel: string
  apikey?: string
  packageJson?: string
  nodeModules?: string
  text?: boolean
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => (row[index] ?? '').length)))
  const line = widths.map(width => '-'.repeat(width)).join('-+-')
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ')
  return [formatRow(headers), line, ...rows.map(formatRow)].join('\n')
}

export async function runCompatibilityCheck(
  appId: string,
  options: CompatibilityOptions,
): Promise<{ hasIncompatible: boolean, nativePackageCount: number }> {
  const apikey = options.apikey || findSavedKey()
  if (!apikey)
    throw new Error('Missing API key. Pass --apikey or run capgo login.')

  const packageJsonPath = options.packageJson ?? join(options.project, 'package.json')
  const nodeModules = options.nodeModules?.split(',').map(path => path.trim()).filter(Boolean)
  const localDependencies = await getReactNativeLocalDependencies(options.project, packageJsonPath, nodeModules)
  const nativePackages = toNativePackages(localDependencies)

  const supabase = await createSupabaseClient(apikey)
  const { finalCompatibility } = await checkCompatibilityNativePackages(
    supabase,
    appId,
    options.channel,
    nativePackages,
  )

  const hasIncompatible = finalCompatibility.some(entry => !isCompatible(entry))
  const yesSymbol = options.text ? 'OK' : '✅'
  const noSymbol = options.text ? 'FAIL' : '❌'
  const rows = finalCompatibility.map((entry) => {
    const details = getCompatibilityDetails(entry)
    return [
      entry.name,
      entry.localVersion || '-',
      entry.remoteVersion || '-',
      details.compatible ? yesSymbol : noSymbol,
      details.message,
    ]
  })

  if (rows.length === 0) {
    log.info(`No native React Native packages detected (${nativePackages.length} tracked for upload metadata).`)
    return { hasIncompatible: false, nativePackageCount: nativePackages.length }
  }

  log.success('React Native compatibility results')
  log.info(formatTable(['Package', 'Local', 'Remote', 'Status', 'Details'], rows))

  if (hasIncompatible) {
    const incompatibleCount = finalCompatibility.filter(entry => !isCompatible(entry)).length
    log.warn(color.yellow(`\n${incompatibleCount} package(s) are incompatible with channel "${options.channel}"`))
    log.warn('A native build / app store update may be required for these changes.')
  }
  else {
    log.success(`\nAll native packages are compatible with channel "${options.channel}"`)
  }

  return { hasIncompatible, nativePackageCount: nativePackages.length }
}

export async function runCompatibility(appId: string, options: CompatibilityOptions): Promise<void> {
  intro('Check React Native bundle compatibility')
  const result = await runCompatibilityCheck(appId, options)
  if (result.hasIncompatible)
    process.exitCode = 1
}

export async function scanNativePackagesForUpload(
  project: string,
  packageJsonPath?: string,
  nodeModules?: string,
): Promise<ReturnType<typeof toNativePackages>> {
  const localDependencies = await getReactNativeLocalDependencies(
    project,
    packageJsonPath,
    nodeModules?.split(',').map(path => path.trim()).filter(Boolean),
  )
  return toNativePackages(localDependencies)
}
