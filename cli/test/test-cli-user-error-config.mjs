#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chdir, cwd } from 'node:process'
import { setConfigWriteTarget } from '../src/config/index.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { getConfigForWrite, getOrganizationId } from '../src/utils.ts'

const NO_CONFIG_MESSAGE = 'No capacitor config file found, run `cap init` first'
const ORG_ID_MESSAGE = 'Cannot get organization id for app'

function assertCliUserError(error, message, contextKeys = []) {
  assert.equal(error instanceof CliUserError, true, `expected CliUserError, got ${error}`)
  assert.equal(error.message, message)
  for (const key of contextKeys)
    assert.ok(error.context?.[key] !== undefined, `expected context.${key}`)
}

const brokenConfigDir = mkdtempSync(join(tmpdir(), 'capgo-broken-cap-config-'))
const invalidConfigTarget = join(brokenConfigDir, 'capacitor.config.invalid.json')
writeFileSync(invalidConfigTarget, '{not json')
const previousCwd = cwd()
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
  chdir(previousCwd)
  globalThis.fetch = originalFetch
  rmSync(brokenConfigDir, { recursive: true, force: true })
}
