#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pack = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }
import { runBundle } from './bundle.js'
import { runInit } from './init.js'
import { runUpload } from './upload.js'

const program = new Command()

program
  .name('capgo-rn')
  .description('Capgo live updates CLI for React Native')
  .version(pack.version)

program
  .command('bundle')
  .description('Export Metro JS bundles + assets for Capgo delta upload')
  .option('--project <path>', 'React Native project root', process.cwd())
  .option('--out <path>', 'Export directory', '.capgo-rn/export')
  .option('--entry-file <path>', 'Metro entry file', 'index.js')
  .option('--platform <platform>', 'android | ios | both', 'both')
  .option('--dev', 'Build in development mode', false)
  .action(async (opts) => {
    await runBundle(opts)
  })

program
  .command('upload')
  .description('Bundle (unless --path) and upload to Capgo with --delta')
  .argument('<appId>', 'Capgo app id (e.g. com.example.app)')
  .option('--project <path>', 'React Native project root', process.cwd())
  .option('--path <path>', 'Existing export directory (skip metro bundle)')
  .option('--out <path>', 'Export directory when bundling', '.capgo-rn/export')
  .option('--entry-file <path>', 'Metro entry file', 'index.js')
  .option('--platform <platform>', 'android | ios | both', 'both')
  .option('-c, --channel <channel>', 'Channel name', 'production')
  .option('-a, --apikey <apikey>', 'Capgo API key')
  .option('--bundle <version>', 'Bundle version name')
  .option('--delta-only', 'Upload delta files only (no zip)', false)
  .option('--no-delta', 'Disable delta upload')
  .option('--dry-run', 'Bundle only, do not upload', false)
  .option('--capgo-cli <bin>', 'Capgo CLI binary', 'capgo')
  .action(async (appId, opts) => {
    await runUpload(appId, opts)
  })

program
  .command('init')
  .description('Print React Native Capgo wiring steps and ensure packages')
  .option('--project <path>', 'React Native project root', process.cwd())
  .action(async (opts) => {
    await runInit(opts)
  })

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
