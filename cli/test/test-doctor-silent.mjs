#!/usr/bin/env node
// SDK/MCP doctor (silent) must report outdated packages as data, not throw a bare error.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

process.env.CAPGO_DISABLE_TELEMETRY = '1'
const { getInfoInternal } = await import('../src/app/info.ts')

console.log('🧪 Testing silent doctor...\n')

const originalFetch = globalThis.fetch
const originalCwd = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'capgo-doctor-silent-'))

try {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
  writeFileSync(join(dir, 'capacitor.config.json'), JSON.stringify({ appId: 'com.demo.app', appName: 'Demo', webDir: 'dist' }))
  process.chdir(dir)
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://registry.npmjs.org/'))
      return new Response(JSON.stringify({ 'dist-tags': { latest: '99.0.0' } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }

  const info = await getInfoInternal({}, true)
  // @capgo/cli is always part of the doctor report, so it is the stable outdated entry here.
  const names = info.outdatedDependencies.map(dep => dep.name)
  assert.ok(names.includes('@capgo/cli'), 'outdated package is listed')
  assert.equal(typeof info.updateCommand, 'string')
  assert.ok(info.updateCommand.includes('@capgo/cli'), 'update command names the package')

  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://registry.npmjs.org/'))
      return new Response('', { status: 404 })
    return new Response('{}', { status: 200 })
  }
  const fresh = await getInfoInternal({}, true)
  assert.deepEqual(fresh.outdatedDependencies, [], 'nothing outdated when no newer version is known')
  assert.equal(fresh.updateCommand, undefined)

  console.log('✅ Silent doctor tests passed')
}
finally {
  globalThis.fetch = originalFetch
  process.chdir(originalCwd)
  rmSync(dir, { recursive: true, force: true })
}
