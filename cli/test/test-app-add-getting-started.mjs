#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  appGettingStartedUrl,
  formatAppGettingStartedMessage,
  resolveAppGettingStartedMessage,
  shouldPrintAppGettingStartedUrl,
} from '../src/app/add.ts'
import { defaultHostWeb } from '../src/utils.ts'

console.log('🧪 Testing app add getting-started URL...\n')

const appId = 'com.example.app'
const expectedUrl = `${defaultHostWeb}/app/${appId}/getting-started`

assert.equal(appGettingStartedUrl(appId), expectedUrl)
assert.equal(appGettingStartedUrl(appId, 'https://dashboard.example.com/'), `https://dashboard.example.com/app/${appId}/getting-started`)
assert.equal(
  formatAppGettingStartedMessage(appId),
  `Continue setup at ${expectedUrl}`,
)

assert.equal(shouldPrintAppGettingStartedUrl(defaultHostWeb, false), true)
assert.equal(shouldPrintAppGettingStartedUrl(defaultHostWeb, true), false)
assert.equal(shouldPrintAppGettingStartedUrl(`${defaultHostWeb}/`, true), false)
assert.equal(shouldPrintAppGettingStartedUrl('https://dashboard.example.com', true), true)

const tempDirs = []
function makeTempDir(name) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `capgo-cli-getting-started-${name}-`)))
  tempDirs.push(dir)
  return dir
}

function writeCapacitorConfig(root, updater = {}) {
  writeFileSync(join(root, 'capacitor.config.json'), JSON.stringify({
    appId,
    appName: 'demo',
    webDir: 'www',
    plugins: { CapacitorUpdater: updater },
  }, null, 2))
}

async function withTempProject(name, updater, fn) {
  const root = makeTempDir(name)
  const previousCwd = process.cwd()
  writeCapacitorConfig(root, updater)
  process.chdir(root)
  try {
    return await fn()
  }
  finally {
    process.chdir(previousCwd)
  }
}

assert.equal(
  await withTempProject('default-host', {}, () => resolveAppGettingStartedMessage(appId)),
  `Continue setup at ${expectedUrl}`,
)

assert.equal(
  await withTempProject('custom-dashboard', {
    localWebHost: 'https://dashboard.example.com',
    localSupa: 'https://supabase.example.com',
    localSupaAnon: 'anon-key',
  }, () => resolveAppGettingStartedMessage(appId)),
  `Continue setup at https://dashboard.example.com/app/${appId}/getting-started`,
)

assert.equal(
  await withTempProject('custom-supabase-only', {
    localSupa: 'https://supabase.example.com',
    localSupaAnon: 'anon-key',
  }, () => resolveAppGettingStartedMessage(appId)),
  null,
)

assert.equal(
  await withTempProject('cli-supa-host', {}, () => resolveAppGettingStartedMessage(appId, {
    supaHost: 'https://supabase.example.com',
    supaAnon: 'anon-key',
  })),
  null,
)

assert.equal(
  await withTempProject('trailing-slash-default', {
    localWebHost: `${defaultHostWeb}/`,
    localSupa: 'https://supabase.example.com',
    localSupaAnon: 'anon-key',
  }, () => resolveAppGettingStartedMessage(appId)),
  null,
)

for (const dir of tempDirs)
  rmSync(dir, { recursive: true, force: true })

console.log('✅ app add getting-started URL tests passed')
