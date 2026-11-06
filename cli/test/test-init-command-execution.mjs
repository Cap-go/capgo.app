#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Compile the probe once, then exercise it in native Node (including Node 20),
// whose Windows command resolution differs from Bun's.
if (process.versions.bun) {
  const root = mkdtempSync(join(tmpdir(), 'capgo-init-probe-module-'))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL('../src/init/command-execution.ts', import.meta.url))],
      target: 'node',
      format: 'esm',
    })
    assert.equal(build.success, true, JSON.stringify(build.logs))
    const modulePath = join(root, 'command-execution.mjs')
    writeFileSync(modulePath, await build.outputs[0].text())
    const result = spawnSync(process.env.CAPGO_TEST_NODE ?? 'node', [fileURLToPath(import.meta.url)], {
      env: { ...process.env, CAPGO_INIT_PROBE_MODULE: pathToFileURL(modulePath).href },
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
  const { probeExecutable, probePackageManagerCommand } = await import(process.env.CAPGO_INIT_PROBE_MODULE)

  test('package manager probes launch Windows command shims', () => {
    const probeModule = process.env.CAPGO_INIT_PROBE_MODULE
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      Object.defineProperty(process, 'platform', { value: 'win32' })
      childProcess.spawnSync = (command) => /(?:cmd|powershell)(?:\\.exe)?$/i.test(command)
        ? { status: 0, stdout: '11.0.0\\n' }
        : { error: Object.assign(new Error('Windows cannot execute a .cmd directly'), { code: 'ENOENT' }) }
      syncBuiltinESMExports()
      const { probePackageManagerCommand } = await import(${JSON.stringify(probeModule)})
      for (const command of ['npm', 'npx', 'pnpm exec', 'yarn dlx'])
        assert.equal(probePackageManagerCommand(command).available, true, command)
    `], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  })

  test('Windows command launches reject line breaks before calling the OS', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      Object.defineProperty(process, 'platform', { value: 'win32' })
      childProcess.spawn = childProcess.spawnSync = () => { throw new Error('OS launch reached') }
      syncBuiltinESMExports()
      const { spawnCommand, spawnCommandSync } = await import(${JSON.stringify(process.env.CAPGO_INIT_PROBE_MODULE)})
      for (const launch of [spawnCommand, spawnCommandSync]) {
        for (const value of ['first\\nsecond', 'first\\rsecond']) {
          assert.throws(() => launch('npx', ['cap', 'init', value]), /line breaks/)
          assert.throws(() => launch(value, []), /line breaks/)
        }
      }
    `], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  })

  test('package manager probes find PATH shims from project paths containing spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'capgo init probes '))
    const bin = join(root, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    try {
      for (const name of ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx']) {
        const windows = process.platform === 'win32'
        writeFileSync(join(bin, `${name}${windows ? '.cmd' : ''}`), windows
          ? '@echo off\r\necho 11.0.0\r\n'
          : '#!/bin/sh\nprintf "11.0.0\\n"\n', { mode: 0o755 })
      }
      const options = { cwd: root, env: { PATH: bin, Path: bin } }
      for (const command of ['npm', 'npx', 'pnpm exec', 'yarn dlx', 'bun', 'bunx']) {
        const probe = probePackageManagerCommand(command, options)
        assert.equal(probe.available, true, `${command}: ${probe.error?.message}`)
        assert.equal(probe.stdout.trim(), '11.0.0')
      }
      const missing = probeExecutable('__capgo_missing_package_manager__', options)
      assert.equal(missing.available, false)
      assert.equal(missing.error?.code, 'ENOENT')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('executable probes preserve nonzero exit status and literal arguments', () => {
    const result = probeExecutable(process.execPath, {
      args: ['-e', 'process.stdout.write(process.argv[1]); process.exit(7)', 'hello & echo unexpected'],
    })
    assert.equal(result.available, false)
    assert.equal(result.status, 7)
    assert.equal(result.stdout, 'hello & echo unexpected')
  })

  test('executable probes time out unresponsive commands', () => {
    const result = probeExecutable(process.execPath, {
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 100,
    })
    assert.equal(result.available, false)
    assert.equal(result.error?.code, 'ETIMEDOUT')
  })
}
