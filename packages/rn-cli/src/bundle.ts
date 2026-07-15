import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { log, spinner } from '@clack/prompts'
import color from 'picocolors'

export interface BundleOptions {
  project: string
  out: string
  entryFile: string
  platform: string
  dev?: boolean
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

function findMetroBin(project: string): string {
  const local = join(project, 'node_modules', 'react-native', 'cli.js')
  if (existsSync(local)) return local
  const rnCli = join(project, 'node_modules', '@react-native-community', 'cli', 'build', 'bin.js')
  if (existsSync(rnCli)) return rnCli
  return 'react-native'
}

function copyAssets(fromDir: string, toDir: string) {
  if (!existsSync(fromDir)) return
  mkdirSync(toDir, { recursive: true })
  for (const entry of readdirSync(fromDir)) {
    const src = join(fromDir, entry)
    const dest = join(toDir, entry)
    const st = statSync(src)
    if (st.isDirectory()) {
      copyAssets(src, dest)
    }
    else {
      cpSync(src, dest)
    }
  }
}

export async function runBundle(options: BundleOptions): Promise<string> {
  const project = resolve(options.project)
  const out = resolve(project, options.out)
  const entryFile = options.entryFile
  const platforms = options.platform === 'both'
    ? ['android', 'ios']
    : [options.platform]

  if (!existsSync(join(project, 'package.json'))) {
    throw new Error(`No package.json in ${project}`)
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  mkdirSync(join(out, 'assets'), { recursive: true })

  const s = spinner()
  s.start(`Exporting Metro bundles (${platforms.join(', ')})`)

  const metroBin = findMetroBin(project)
  const useNode = metroBin.endsWith('.js')

  for (const platform of platforms) {
    const bundleOut = platform === 'ios'
      ? join(out, 'main.jsbundle')
      : join(out, 'index.android.bundle')
    const assetsDest = join(out, 'assets')
    const args = [
      ...(useNode ? [metroBin] : []),
      'bundle',
      '--platform', platform,
      '--dev', options.dev ? 'true' : 'false',
      '--entry-file', entryFile,
      '--bundle-output', bundleOut,
      '--assets-dest', assetsDest,
      '--reset-cache',
    ]
    const cmd = useNode ? process.execPath : metroBin
    await run(cmd, useNode ? args : args, project)
    if (!existsSync(bundleOut)) {
      throw new Error(`Metro did not produce ${bundleOut}`)
    }
  }

  s.stop(color.green(`Export ready at ${out}`))
  log.info(`Files: ${readdirSync(out).join(', ')}`)
  return out
}
