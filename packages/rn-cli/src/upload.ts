import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { log, spinner } from '@clack/prompts'
import color from 'picocolors'
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
  capgoCli: string
  ignoreMetadataCheck?: boolean
  failOnIncompatible?: boolean
  nodeModules?: string
  packageJson?: string
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false, env: process.env })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} exited with ${code}`))
    })
  })
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
  const metadataDir = mkdtempSync(join(tmpdir(), 'capgo-rn-metadata-'))
  const nativePackagesFile = join(metadataDir, 'native-packages.json')
  writeFileSync(nativePackagesFile, JSON.stringify(nativePackages))

  const s = process.stdout.isTTY ? spinner() : null
  if (s) s.start('Uploading to Capgo with file-level delta')

  const useDelta = options.delta !== false
  if (!useDelta && options.deltaOnly) {
    throw new Error('--delta-only cannot be combined with --no-delta')
  }
  const args = [
    'bundle', 'upload',
    appId,
    '--path', exportPath,
    '--channel', options.channel,
    '--no-code-check',
    '--ignore-metadata-check',
    '--native-packages-file', nativePackagesFile,
    '--package-json', packageJsonPath,
  ]

  if (useDelta) args.push('--delta')
  if (options.deltaOnly) args.push('--delta-only')
  if (options.apikey) args.push('--apikey', options.apikey)
  if (options.bundle) args.push('--bundle', options.bundle)
  if (options.nodeModules) args.push('--node-modules', options.nodeModules)

  const localCapgoJs = resolve(project, 'node_modules', '@capgo/cli', 'dist', 'index.js')
  const monorepoCapgoJs = resolve(project, '..', '..', 'cli', 'dist', 'index.js')
  const monorepoFromPackages = resolve(project, '..', 'cli', 'dist', 'index.js')

  let cmd = options.capgoCli
  let cmdArgs = args
  if (existsSync(localCapgoJs)) {
    cmd = process.execPath
    cmdArgs = [localCapgoJs, ...args]
  }
  else if (existsSync(monorepoCapgoJs)) {
    cmd = process.execPath
    cmdArgs = [monorepoCapgoJs, ...args]
  }
  else if (existsSync(monorepoFromPackages)) {
    cmd = process.execPath
    cmdArgs = [monorepoFromPackages, ...args]
  }

  try {
    await run(cmd, cmdArgs, project)
    if (s) s.stop(color.green('Upload complete'))
  }
  catch (error) {
    if (s) s.stop(color.red('Upload failed'))
    throw error
  }
  finally {
    rmSync(metadataDir, { recursive: true, force: true })
  }
}
