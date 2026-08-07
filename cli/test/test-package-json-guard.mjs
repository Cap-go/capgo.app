import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBundleVersion, getPackageScripts } from '../src/utils.ts'

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
  const dir = join(tmpdir(), `capgo-cli-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Regression: running `capgo init` (and doctor) from a directory without a
// package.json used to escape as a raw Node ENOENT stack trace. readPackageJson
// must now guard the default path and surface an actionable message.
await test('getBundleVersion throws a helpful message when package.json is missing', async () => {
  const dir = makeDir('missing-pkg')
  try {
    assert.throws(
      () => getBundleVersion(dir),
      (error) => {
        assert.ok(!(error instanceof Error && 'code' in error && error.code === 'ENOENT'), 'should not surface a raw ENOENT')
        assert.match(error.message, /No package\.json found at/)
        assert.match(error.message, /project root/)
        assert.match(error.message, /--package-json/)
        return true
      },
    )
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('getPackageScripts throws the explicit-path message when a supplied package.json is missing', async () => {
  const dir = makeDir('missing-explicit-pkg')
  try {
    const missing = join(dir, 'package.json')
    assert.throws(
      () => getPackageScripts(undefined, missing),
      (error) => {
        assert.match(error.message, /Package\.json at .*package\.json does not exist/)
        return true
      },
    )
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('getBundleVersion reads the version when package.json exists', async () => {
  const dir = makeDir('present-pkg')
  try {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2)}\n`)
    assert.equal(getBundleVersion(dir), '1.2.3')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
