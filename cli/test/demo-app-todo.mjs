#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appId } from './fixtures/dual-todo.mjs'

console.log('Preview with sample progress. No account or network requests are used.\n')
const cwd = mkdtempSync(join(tmpdir(), 'capgo-todo-preview-'))
writeFileSync(join(cwd, 'capacitor.config.json'), JSON.stringify({ appId, appName: 'Todo preview', webDir: 'dist' }))
writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'todo-preview', version: '1.0.0' }))
try {
  const child = spawnSync(process.execPath, [
    '--import', fileURLToPath(new URL('./fixtures/todo-api-preload.mjs', import.meta.url)),
    fileURLToPath(new URL('../dist/index.js', import.meta.url)),
    'app', 'todo', appId,
    '--apikey', 'example-demo-key',
    '--api-host', 'https://todo.fixture.invalid',
    ...process.argv.slice(2),
  ], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CAPGO_DISABLE_TELEMETRY: '1', CAPGO_DISABLE_POSTHOG: '1' },
  })
  process.exitCode = child.status ?? 1
}
finally {
  rmSync(cwd, { recursive: true, force: true })
}
