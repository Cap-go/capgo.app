import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { log, spinner } from '@clack/prompts'
import color from 'picocolors'
import { findSavedKey, uploadBundle } from '@capgo/cli/sdk'
import { runBundle } from './bundle.js'
import { runCompatibilityCheck, scanNativePackagesForUpload } from './compatibility.js'

export interface UploadOptions {
  project: string
  path?: string
  out: string
  entryFile: string
  platform: string
  channel: string
  apikey?: string
  bundle?: string
  deltaOnly?: boolean
  delta?: boolean
  dryRun?: boolean
  ignoreMetadataCheck?: boolean
  failOnIncompatible?: boolean
  nodeModules?: string
  packageJson?: string
}

export async function runUpload(appId: string, options: UploadOptions): Promise<void> {
  const project = resolve(options.project)
  const packageJsonPath = options.packageJson ?? join(project, 'package.json')
  let exportPath = options.path ? resolve(project, options.path) : ''

  if (!exportPath) {
    exportPath = await runBundle({
      project,
      out: options.out,
      entryFile: options.entryFile,
      platform: options.platform,
    })
  }

  if (!existsSync(exportPath)) {
    throw new Error(`Export path not found: ${exportPath}`)
  }

  if (options.dryRun) {
    log.success(`Dry run: export ready at ${exportPath}`)
    return
  }

  if (!options.ignoreMetadataCheck) {
    const compatibility = await runCompatibilityCheck(appId, {
      project,
      channel: options.channel,
      apikey: options.apikey,
      packageJson: packageJsonPath,
      nodeModules: options.nodeModules,
    })
    if (compatibility.hasIncompatible && options.failOnIncompatible) {
      throw new Error(`Upload aborted: bundle is incompatible with channel "${options.channel}". Remove --fail-on-incompatible to upload anyway.`)
    }
  }

  const nativePackages = await scanNativePackagesForUpload(project, packageJsonPath, options.nodeModules)
  const useDelta = options.delta !== false
  if (!useDelta && options.deltaOnly) {
    throw new Error('--delta-only cannot be combined with --no-delta')
  }

  const s = process.stdout.isTTY ? spinner() : null
  if (s) s.start('Uploading to Capgo with file-level delta')

  const result = await uploadBundle({
    appId,
    path: exportPath,
    channel: options.channel,
    apikey: options.apikey ?? findSavedKey(),
    bundle: options.bundle,
    packageJsonPaths: packageJsonPath,
    nodeModules: options.nodeModules,
    disableCodeCheck: true,
    ignoreCompatibilityCheck: true,
    nativePackages,
    delta: useDelta,
    deltaOnly: options.deltaOnly,
  })

  if (!result.success) {
    if (s) s.stop(color.red('Upload failed'))
    throw new Error(result.error ?? 'Upload failed')
  }

  if (result.skipped) {
    if (s) s.stop(color.yellow(`Upload skipped: ${result.reason ?? 'unknown reason'}`))
    return
  }

  if (s) s.stop(color.green('Upload complete'))
}
