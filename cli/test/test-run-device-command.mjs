#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { execPath } from 'node:process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0

function test(name, fn) {
  try {
    fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

test('resolves iOS run device command without launching in non-interactive mode', () => {
  const developerDir = mkdtempSync(join(tmpdir(), 'capgo-test-xcode-'))
  try {
    mkdirSync(join(developerDir, 'Applications', 'Simulator.app'), { recursive: true })
    const result = spawnSync(execPath, ['dist/index.js', 'run', 'device', 'ios', '--no-launch'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DEVELOPER_DIR: developerDir },
    })
    const output = `${result.stdout}\n${result.stderr}`

    assert.equal(result.status, 0, output)
    assert.match(output, /Resolved run command:/)
    assert.match(output, /cap run ios/)
    assert.doesNotMatch(output, /Run device test failed/)
  }
  finally {
    rmSync(developerDir, { recursive: true, force: true })
  }
})

test('requires an interactive terminal when no platform is provided', () => {
  const result = spawnSync(execPath, ['dist/index.js', 'run', 'device', '--no-launch'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.notEqual(result.status, 0, output)
  assert.match(output, /No platform provided/)
  assert.match(output, /choose iOS or Android/)
})

if (failures > 0) {
  console.error(`\n❌ ${failures} run device command test(s) failed`)
  process.exit(1)
}

console.log('\n✅ Run device command handling works')
