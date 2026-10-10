#!/usr/bin/env node
/**
 * Test: `key create` file permissions and .gitignore handling
 *
 * Verifies that createKeyInternal writes .capgo_key_v2 / .capgo_key_v2.pub with mode 0600,
 * appends .capgo_key_v2 to .gitignore exactly once, and keeps --force semantics.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createKeyInternal, gitignoreEntryFor } from '../src/key.ts'
import { appendLineIfMissing } from '../src/utils/safeWrites.ts'

let failures = 0

async function t(name, fn) {
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

const originalCwd = process.cwd()
const isWindows = process.platform === 'win32'

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-key-create-'))
  writeFileSync(join(dir, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.app', appName: 'Example', webDir: 'dist' }, null, 2))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0' }))
  process.chdir(dir)
  return dir
}

function mode(path) {
  return statSync(path).mode & 0o777
}

await t('appendLineIfMissing appends once and dedupes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-gitignore-'))
  const file = join(dir, '.gitignore')
  assert.equal(await appendLineIfMissing(file, '.capgo_key_v2'), true)
  assert.equal(readFileSync(file, 'utf8'), '.capgo_key_v2\n')
  assert.equal(await appendLineIfMissing(file, '.capgo_key_v2'), false)
  assert.equal(readFileSync(file, 'utf8'), '.capgo_key_v2\n')
  // Existing file without trailing newline gets a separator
  writeFileSync(file, 'node_modules')
  assert.equal(await appendLineIfMissing(file, '.capgo_key_v2'), true)
  assert.equal(readFileSync(file, 'utf8'), 'node_modules\n.capgo_key_v2\n')
  // CRLF files and surrounding whitespace are still deduped
  writeFileSync(file, 'node_modules\r\n .capgo_key_v2 \r\n')
  assert.equal(await appendLineIfMissing(file, '.capgo_key_v2'), false)
  rmSync(dir, { recursive: true, force: true })
})

await t('key create writes 0600 key files and git-ignores the private key', async () => {
  const dir = setupProject()
  try {
    await createKeyInternal({}, true)
    assert.ok(existsSync(join(dir, '.capgo_key_v2')))
    assert.ok(existsSync(join(dir, '.capgo_key_v2.pub')))
    assert.ok(readFileSync(join(dir, '.capgo_key_v2'), 'utf8').startsWith('-----BEGIN RSA PRIVATE KEY-----'))
    assert.ok(readFileSync(join(dir, '.capgo_key_v2.pub'), 'utf8').startsWith('-----BEGIN RSA PUBLIC KEY-----'))
    if (!isWindows) {
      assert.equal(mode(join(dir, '.capgo_key_v2')), 0o600)
      assert.equal(mode(join(dir, '.capgo_key_v2.pub')), 0o600)
    }
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.capgo_key_v2\n')
    const config = JSON.parse(readFileSync(join(dir, 'capacitor.config.json'), 'utf8'))
    assert.ok(config.plugins.CapacitorUpdater.publicKey.startsWith('-----BEGIN RSA PUBLIC KEY-----'))
  }
  finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('key create refuses to overwrite without --force and keeps .gitignore deduped with --force', async () => {
  const dir = setupProject()
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n.capgo_key_v2\n')
    await createKeyInternal({}, true)
    const firstPrivate = readFileSync(join(dir, '.capgo_key_v2'), 'utf8')
    await assert.rejects(() => createKeyInternal({}, true), /already exists/)
    assert.equal(readFileSync(join(dir, '.capgo_key_v2'), 'utf8'), firstPrivate)
    await createKeyInternal({ force: true }, true)
    assert.notEqual(readFileSync(join(dir, '.capgo_key_v2'), 'utf8'), firstPrivate)
    if (!isWindows)
      assert.equal(mode(join(dir, '.capgo_key_v2')), 0o600)
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules\n.capgo_key_v2\n')
  }
  finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('gitignoreEntryFor returns repository-relative posix entries or null outside the project', () => {
  const cwd = process.platform === 'win32' ? 'C:\\proj' : '/proj'
  const sep = process.platform === 'win32' ? '\\' : '/'
  assert.equal(gitignoreEntryFor('.capgo_key_v2', cwd), '.capgo_key_v2')
  assert.equal(gitignoreEntryFor(`keys${sep}.capgo_key_v2`, cwd), 'keys/.capgo_key_v2')
  assert.equal(gitignoreEntryFor(`${cwd}${sep}keys${sep}.capgo_key_v2`, cwd), 'keys/.capgo_key_v2')
  assert.equal(gitignoreEntryFor(`${cwd}${sep}..${sep}.capgo_key_v2`, cwd), null)
  assert.equal(gitignoreEntryFor(`..${sep}outside${sep}.capgo_key_v2`, cwd), null)
  assert.equal(gitignoreEntryFor(process.platform === 'win32' ? 'D:\\elsewhere\\.capgo_key_v2' : '/elsewhere/.capgo_key_v2', cwd), null)
})

await t('key create with an absolute keyDir inside the project writes a relative .gitignore entry', async () => {
  const dir = setupProject()
  try {
    const keyDir = join(realpathSync(dir), 'keys')
    mkdirSync(keyDir)
    await createKeyInternal({ keyDir }, true)
    assert.ok(existsSync(join(keyDir, '.capgo_key_v2')))
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'keys/.capgo_key_v2\n')
  }
  finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('key create with a keyDir outside the project skips .gitignore', async () => {
  const dir = setupProject()
  const outside = mkdtempSync(join(tmpdir(), 'capgo-key-outside-'))
  try {
    await createKeyInternal({ keyDir: outside }, true)
    assert.ok(existsSync(join(outside, '.capgo_key_v2')))
    assert.equal(existsSync(join(dir, '.gitignore')), false)
  }
  finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

await t('key create ignores the private key before writing it (no unignored key on failure)', async () => {
  const dir = setupProject()
  try {
    // A directory named .gitignore makes the append fail before any key is written
    mkdirSync(join(dir, '.gitignore'))
    await assert.rejects(() => createKeyInternal({}, true))
    assert.equal(existsSync(join(dir, '.capgo_key_v2')), false)
    assert.equal(existsSync(join(dir, '.capgo_key_v2.pub')), false)
  }
  finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

if (failures > 0) {
  console.error(`\n${failures} key create test(s) failed`)
  process.exit(1)
}
console.log('\nAll key create tests passed')
