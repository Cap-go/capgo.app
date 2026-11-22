#!/usr/bin/env node
/**
 * Cross-spawn runner helpers (npx and multi-word runners, Windows .cmd shims).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const moduleUrl = fileURLToPath(new URL('../src/init/command-execution.ts', import.meta.url))

if (process.versions.bun) {
  const root = mkdtempSync(join(tmpdir(), 'capgo-runner-spawn-probe-'))
  try {
    const build = await Bun.build({
      entrypoints: [moduleUrl],
      target: 'node',
      format: 'esm',
    })
    assert.equal(build.success, true, JSON.stringify(build.logs))
    const probeModule = join(root, 'command-execution.mjs')
    writeFileSync(probeModule, await build.outputs[0].text())
    const result = spawnSync(process.env.CAPGO_TEST_NODE ?? 'node', [fileURLToPath(import.meta.url)], {
      env: { ...process.env, CAPGO_RUNNER_SPAWN_PROBE: pathToFileURL(probeModule).href },
      stdio: 'inherit',
    })
    if (result.error)
      throw result.error
    process.exitCode = result.status ?? 1
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
}
else {
  const probeModule = process.env.CAPGO_RUNNER_SPAWN_PROBE ?? moduleUrl
  const { runPackageRunner, runPackageRunnerSync, waitForCommandResult } = await import(probeModule)

  const root = mkdtempSync(join(tmpdir(), 'capgo runner spawn '))
  const bin = join(root, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const echoArgs = join(bin, 'echo-args.cjs')
  writeFileSync(echoArgs, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const windows = process.platform === 'win32'
  for (const name of ['npx', 'pnpm', 'yarn']) {
    writeFileSync(join(bin, `${name}${windows ? '.cmd' : ''}`), windows
      ? `@"${process.execPath}" "%~dp0echo-args.cjs" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${echoArgs}" "$@"\n`, { mode: 0o755 })
  }

  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const originalPath = process.env[pathKey]
  const args = ['cap', 'sync']
  try {
    process.env[pathKey] = `${bin}${delimiter}${originalPath ?? ''}`

    const npxSync = runPackageRunnerSync('npx', ['-y', ...args], { cwd: root, encoding: 'utf8' })
    assert.ok(!npxSync.error, npxSync.error?.message)
    assert.equal(npxSync.status, 0)
    assert.deepEqual(JSON.parse(String(npxSync.stdout)), ['-y', ...args])

    const pnpmSync = runPackageRunnerSync('pnpm exec', args, { cwd: root, encoding: 'utf8' })
    assert.equal(pnpmSync.status, 0)
    assert.deepEqual(JSON.parse(String(pnpmSync.stdout)), ['exec', ...args])

    const child = runPackageRunner('npx', ['-y', ...args], { cwd: root, stdio: 'pipe' })
    const asyncResult = await waitForCommandResult(child)
    assert.equal(asyncResult.success, true, asyncResult.error?.message)

    const missing = runPackageRunnerSync('npx', ['-y', 'noop'], {
      cwd: root,
      env: { ...process.env, [pathKey]: join(root, 'empty-path') },
      encoding: 'utf8',
    })
    assert.ok(missing.error || missing.status !== 0, 'expected missing npx to fail')
  }
  finally {
    process.env[pathKey] = originalPath
    rmSync(root, { recursive: true, force: true })
  }

  process.stdout.write('test-cli-runner-spawn: ok\n')
}
