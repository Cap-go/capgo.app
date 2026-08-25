#!/usr/bin/env node
// Parallel-safe bundle tests use withCwd or absolute paths — never bare process.chdir().
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chdir, cwd } from 'node:process'
import { withCwd } from '../src/build/cwd.ts'
import { setConfigWriteTarget } from '../src/config/index.ts'
import { encryptZipInternal } from '../src/bundle/encrypt.ts'
import { zipBundleInternal } from '../src/bundle/zip.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { getAppId, getConfigForWrite, getOrganizationId } from '../src/utils.ts'

const NO_CONFIG_MESSAGE = 'No capacitor config file found, run `cap init` first'
const ORG_ID_MESSAGE = 'Cannot get organization id for app'

function assertCliUserError(error, message, contextKeys = []) {
  assert.equal(error instanceof CliUserError, true, `expected CliUserError, got ${error}`)
  assert.equal(error.message, message)
  for (const key of contextKeys)
    assert.ok(error.context?.[key] !== undefined, `expected context.${key}`)
}

async function test(name, fn) {
  try {
    await fn()
    process.stdout.write(`✓ ${name}\n`)
  }
  catch (error) {
    process.stderr.write(`✗ ${name}\n`)
    throw error
  }
}

function makeDir(name) {
  // Use /tmp explicitly — os.tmpdir() on GitHub Actions is under the workspace,
  // so Capacitor's upward config search would pick up the repo's appId.
  const dir = mkdtempSync(`/tmp/capgo-cli-user-error-${name}-`)
  return dir
}

function writeCapacitorProject(dir, webDirName = 'www') {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2))
  writeFileSync(
    join(dir, 'capacitor.config.json'),
    JSON.stringify({ appId: 'com.example.app', webDir: webDirName }, null, 2),
  )
}

const brokenConfigDir = mkdtempSync(join(tmpdir(), 'capgo-broken-cap-config-'))
const invalidConfigTarget = join(brokenConfigDir, 'capacitor.config.invalid.json')
const missingConfigTarget = join(brokenConfigDir, 'capacitor.config.missing.json')
const emptyConfigTarget = join(brokenConfigDir, 'capacitor.config.empty.json')
writeFileSync(invalidConfigTarget, '{not json')
writeFileSync(emptyConfigTarget, '{}')
const configOrgPreviousCwd = cwd()
const originalFetch = globalThis.fetch

try {
  chdir(brokenConfigDir)
  setConfigWriteTarget(invalidConfigTarget)
  let configError
  try {
    await getConfigForWrite(true)
  }
  catch (error) {
    configError = error
  }
  assertCliUserError(configError, NO_CONFIG_MESSAGE, ['cause'])
  assert.equal(
    new CliUserError(NO_CONFIG_MESSAGE).message,
    new CliUserError(NO_CONFIG_MESSAGE, { cause: 'typescript missing' }).message,
  )
  assert.match(String(configError.context.cause), /JSON|Unexpected|parse/i)

  setConfigWriteTarget(missingConfigTarget)
  let missingConfigError
  try {
    await getConfigForWrite(true)
  }
  catch (error) {
    missingConfigError = error
  }
  assertCliUserError(missingConfigError, NO_CONFIG_MESSAGE, ['cause'])

  setConfigWriteTarget(emptyConfigTarget)
  const emptyConfig = await getConfigForWrite(true)
  assert.deepEqual(emptyConfig.config, {})

  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 })
  let orgError
  try {
    await getOrganizationId('test-api-key', 'com.example.missing')
  }
  catch (error) {
    orgError = error
  }
  assertCliUserError(orgError, ORG_ID_MESSAGE, ['appId', 'cause'])
  assert.equal(orgError.context.appId, 'com.example.missing')
  assert.equal(
    new CliUserError(ORG_ID_MESSAGE, { appId: 'com.one.app' }).message,
    new CliUserError(ORG_ID_MESSAGE, { appId: 'com.other.app' }).message,
  )

  globalThis.fetch = async () => new Response('not found', { status: 404 })
  let orgHttpError
  try {
    await getOrganizationId('test-api-key', 'com.example.denied')
  }
  catch (error) {
    orgHttpError = error
  }
  assertCliUserError(orgHttpError, ORG_ID_MESSAGE, ['appId', 'cause'])
  assert.equal(orgHttpError.context.appId, 'com.example.denied')

  console.log('CLI CliUserError config/org tests passed')
}
finally {
  setConfigWriteTarget(undefined)
  chdir(configOrgPreviousCwd)
  globalThis.fetch = originalFetch
  rmSync(brokenConfigDir, { recursive: true, force: true })
}

await test('zipBundleInternal throws CliUserError when notifyAppReady is missing', async () => {
  const dir = makeDir('notify-app-ready')
  const webDir = join(dir, 'www')
  mkdirSync(webDir)
  writeFileSync(join(webDir, 'index.html'), '<html></html>')
  writeFileSync(join(webDir, 'main.js'), 'console.log("hello")')

  try {
    await assert.rejects(
      () => zipBundleInternal('com.example.app', { path: webDir, bundle: '1.0.0' }, true),
      (error) => {
        assert.equal(error instanceof CliUserError, true)
        assert.equal(error.message, 'notifyAppReady() is missing in build folder')
        assert.equal(shouldCapturePosthogException(error), false)
        return true
      },
    )
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('encryptZipInternal throws CliUserError when public key is missing from config', async () => {
  const dir = makeDir('missing-public-key')
  const zipPath = join(dir, 'bundle.zip')
  writeFileSync(zipPath, 'zip-placeholder')
  writeCapacitorProject(dir)

  try {
    await withCwd(dir, async () => {
      await assert.rejects(
        () => encryptZipInternal(zipPath, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', {}, true),
        (error) => {
          assert.equal(error instanceof CliUserError, true)
          assert.equal(error.message, 'Missing public key in config')
          assert.equal(shouldCapturePosthogException(error), false)
          return true
        },
      )
    })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('missing appId guard throws CliUserError skipped by PostHog', () => {
  assert.equal(getAppId('', { webDir: 'www' }), undefined)
  assert.equal(getAppId(undefined, undefined), undefined)

  const error = new CliUserError('Missing appId')
  assert.equal(error.message, 'Missing appId')
  assert.equal(shouldCapturePosthogException(error), false)
})
