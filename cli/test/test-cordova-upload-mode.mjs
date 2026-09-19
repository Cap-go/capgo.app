#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { chdir, cwd } from 'node:process'
import { withCwd } from '../src/build/cwd.ts'
import { buildCordovaUploadConfig, collectCordovaAppIdCandidates, CORDOVA_DEFAULT_WEB_DIR } from '../src/cordova/project.ts'
import { buildMissingCapacitorConfigUploadMessage, loadUploadProjectConfig } from '../src/bundle/upload-config.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { NO_CAPACITOR_CONFIG_MESSAGE } from '../src/utils.ts'

const cliDir = new URL('..', import.meta.url)

function t(name, fn) {
  return (async () => {
    try {
      await fn()
      process.stdout.write(`✓ ${name}\n`)
    }
    catch (error) {
      process.stderr.write(`✗ ${name}\n`)
      throw error
    }
  })()
}

function writeCordovaProject(dir, { appId = 'com.example.cordova', webDir = 'www' } = {}) {
  writeFileSync(join(dir, 'config.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<widget id="${appId}" version="1.0.0">
  <content src="index.html" />
</widget>`)
  mkdirSync(join(dir, webDir), { recursive: true })
  writeFileSync(join(dir, webDir, 'index.html'), '<html><body>notifyAppReady()</body></html>')
}

await t('collectCordovaAppIdCandidates reads config.xml widget id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-cordova-config-'))
  try {
    writeCordovaProject(dir, { appId: 'com.customer.cordova' })
    assert.deepEqual(collectCordovaAppIdCandidates(dir), ['com.customer.cordova'])
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('collectCordovaAppIdCandidates reads plugin.xml id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-cordova-plugin-'))
  try {
    writeFileSync(join(dir, 'plugin.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<plugin id="com.customer.plugin" version="1.0.0"></plugin>`)
    assert.deepEqual(collectCordovaAppIdCandidates(dir), ['com.customer.plugin'])
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('buildCordovaUploadConfig defaults webDir to www', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-cordova-default-www-'))
  try {
    writeCordovaProject(dir)
    await withCwd(dir, async () => {
      const config = buildCordovaUploadConfig({})
      assert.equal(config.config.webDir, CORDOVA_DEFAULT_WEB_DIR)
      assert.equal(config.config.appId, 'com.example.cordova')
      assert.equal(config.path, '')
    })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('loadUploadProjectConfig resolves cordova mode without capacitor.config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-cordova-upload-config-'))
  try {
    writeCordovaProject(dir, { appId: 'com.upload.cordova', webDir: 'www' })
    await withCwd(dir, async () => {
      const config = await loadUploadProjectConfig({ mode: 'cordova', path: 'www' }, { appId: 'com.upload.cordova' })
      assert.equal(config.config.webDir, 'www')
      assert.equal(config.config.appId, 'com.upload.cordova')
    })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('missing capacitor config suggests --mode cordova on upload', async () => {
  // Use /tmp explicitly — os.tmpdir() on GitHub Actions is under the workspace,
  // so Capacitor's upward config search would pick up this monorepo's appId.
  const dir = mkdtempSync('/tmp/capgo-missing-cap-config-')
  const previousCwd = cwd()
  try {
    chdir(dir)
    await assert.rejects(
      () => loadUploadProjectConfig({ channel: 'production', path: 'www' }, { appId: 'com.example.app' }),
      (error) => {
        assert.equal(error instanceof CliUserError, true)
        assert.match(error.message, new RegExp(NO_CAPACITOR_CONFIG_MESSAGE))
        assert.match(error.message, /--mode cordova/)
        assert.match(error.message, /--channel production/)
        return true
      },
    )
    const hint = buildMissingCapacitorConfigUploadMessage({
      appId: 'com.example.app',
      path: 'www',
      channel: 'production',
    })
    assert.match(hint, /npx @capgo\/cli@latest bundle upload com\.example\.app --mode cordova --path www --channel production/)
  }
  finally {
    chdir(previousCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('bundle upload rejects unknown --mode values', async () => {
  const result = spawnSync(process.execPath, ['dist/index.js', 'bundle', 'upload', 'com.example.app', '--mode', 'react-native'], {
    cwd: cliDir,
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stderr}\n${result.stdout}`, /invalid|error/i)
})

console.log('Cordova upload mode tests passed')
