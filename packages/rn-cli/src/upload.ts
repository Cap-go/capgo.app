import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { log, spinner } from '@clack/prompts'
import color from 'picocolors'
import { runBundle } from './bundle.js'

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
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: process.env })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} exited with ${code}`))
    })
  })
}


export async function runUpload(appId: string, options: UploadOptions): Promise<void> {
  const project = resolve(options.project)
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

  const s = spinner()
  s.start('Uploading to Capgo with file-level delta')

  const useDelta = options.delta !== false
  const args = [
    'bundle', 'upload',
    appId,
    '--path', exportPath,
    '--channel', options.channel,
    '--no-code-check',
  ]

  if (useDelta) args.push('--delta')
  if (options.deltaOnly) args.push('--delta-only')
  if (options.apikey) args.push('--apikey', options.apikey)
  if (options.bundle) args.push('--bundle', options.bundle)

  // Prefer local @capgo/cli from monorepo/workspace
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
    s.stop(color.green('Upload complete'))
  }
  catch (error) {
    s.stop(color.red('Upload failed'))
    throw error
  }
}
