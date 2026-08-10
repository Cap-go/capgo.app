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
// must now guard the default path and throw a CliUserError with a constant,
// actionable message, so error tracking skips it and does not open one issue
// per absolute path.
await test('getBundleVersion throws a CliUserError when package.json is missing', async () => {
  const dir = makeDir('missing-pkg')
  try {
    assert.throws(
      () => getBundleVersion(dir),
      (error) => {
        assert.ok(!(error instanceof Error && 'code' in error && error.code === 'ENOENT'), 'should not surface a raw ENOENT')
        assert.equal(error.name, 'CliUserError')
        // Constant, actionable message (no interpolated path) so error tracking
        // fingerprints one issue; the path travels in context instead.
        assert.equal(error.message, 'package.json not found. Run this command from your project root, or pass --package-json <path>.')
        assert.match(error.context.packageJsonPath, /package\.json$/)
        return true
      },
    )
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('getPackageScripts throws a CliUserError with the path in context for an explicit package.json', async () => {
  const dir = makeDir('missing-explicit-pkg')
  try {
    const missing = join(dir, 'package.json')
    assert.throws(
      () => getPackageScripts(undefined, missing),
      (error) => {
        assert.equal(error.name, 'CliUserError')
        assert.equal(error.message, 'package.json not found. Run this command from your project root, or pass --package-json <path>.')
        assert.equal(error.context.packageJsonPath, missing)
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
