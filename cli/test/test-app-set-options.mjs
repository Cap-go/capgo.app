#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolveAppSetIconPath } from '../src/api/app.ts'
import { getAppListHeaders, getAppListRow } from '../src/app/list.ts'
import { normalizeStoreUrl } from '../src/app/store-url.ts'

let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

await test('normalizes ios store urls', () => {
  assert.equal(
    normalizeStoreUrl('https://apps.apple.com/app/id123', 'apps.apple.com'),
    'https://apps.apple.com/app/id123',
  )
})

await test('normalizes android store urls', () => {
  assert.equal(
    normalizeStoreUrl('https://play.google.com/store/apps/details?id=com.demo', 'play.google.com'),
    'https://play.google.com/store/apps/details?id=com.demo',
  )
})

await test('rejects prefixed subdomains', () => {
  assert.throws(
    () => normalizeStoreUrl('https://evilapps.apple.com/app', 'apps.apple.com'),
    /apps\.apple\.com/,
  )
})

await test('rejects invalid store hosts', () => {
  assert.throws(
    () => normalizeStoreUrl('https://example.com/app', 'apps.apple.com'),
    /apps\.apple\.com/,
  )
})

await test('does not resolve app set icon without --icon', () => {
  assert.equal(resolveAppSetIconPath(undefined), undefined)
})

await test('resolves app set icon only when --icon is passed', () => {
  assert.equal(resolveAppSetIconPath('./assets/capgo-icon.png'), './assets/capgo-icon.png')
})

await test('places optional organization columns around Created', () => {
  assert.deepEqual(getAppListHeaders({ apikey: 'test' }), ['Name', 'id', 'Created'])
  assert.deepEqual(getAppListHeaders({ apikey: 'test', showOrg: true, showOrgId: true }), [
    'Name',
    'id',
    'Organization',
    'Created',
    'Organization ID',
  ])
})

await test('renders organization name and id from the app owner', () => {
  const row = getAppListRow({
    name: 'Production App',
    app_id: 'com.acme.app',
    created_at: '2026-08-21T00:00:00Z',
    owner_org: 'org-123',
  }, { apikey: 'test', showOrg: true, showOrgId: true }, new Map([['org-123', 'Acme']]))

  assert.equal(row[2], 'Acme')
  assert.equal(row[4], 'org-123')
})

await test('registers both app list organization display flags', () => {
  const builtCli = new URL('../dist/index.js', import.meta.url)
  const cliSource = new URL('../src/index.ts', import.meta.url)
  assert.equal(existsSync(builtCli), true, 'Run `bun run build` before this test')
  assert.ok(statSync(builtCli).mtimeMs >= statSync(cliSource).mtimeMs, 'Run `bun run build` before this test; dist/index.js is stale')

  const help = spawnSync(process.execPath, ['dist/index.js', 'app', 'list', '--help'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--show-org\b(?!-)/)
  assert.match(help.stdout, /--show-org-id\b/)
})

if (failures > 0) {
  console.error(`\n❌ ${failures} app set option test(s) failed`)
  process.exit(1)
}

console.log('\n✅ App set option checks work')
