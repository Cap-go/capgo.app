#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createKeyInternal } = await import('../src/key.ts')
const { baseKeyPubV2, baseKeyV2 } = await import('../src/utils.ts')

const isWindows = process.platform === 'win32'
const fileMode = path => statSync(path).mode & 0o777

const root = mkdtempSync(join(tmpdir(), 'capgo-key-mode-'))
const previousUmask = process.umask(0o022)
const previousCwd = process.cwd()
process.chdir(root)

try {
  const keyDir = join(root, 'keys')
  mkdirSync(keyDir)

  await createKeyInternal({ keyDir }, true, { config: {}, path: join(root, 'capacitor.config.json') })
  if (!isWindows) {
    assert.equal(fileMode(join(keyDir, baseKeyV2)), 0o600, 'new private key must be owner-only')
    assert.equal(fileMode(join(keyDir, baseKeyPubV2)) & 0o600, 0o600, 'public key stays readable by owner')
  }

  // --force over an existing world-readable key must tighten it as well.
  writeFileSync(join(keyDir, baseKeyV2), 'old', { mode: 0o644 })
  await createKeyInternal({ keyDir, force: true }, true, { config: {}, path: join(root, 'capacitor.config.json') })
  if (!isWindows)
    assert.equal(fileMode(join(keyDir, baseKeyV2)), 0o600, 'overwritten private key must be owner-only')

  console.log('✅ key create writes the private key with mode 0600')
}
finally {
  process.chdir(previousCwd)
  process.umask(previousUmask)
  rmSync(root, { recursive: true, force: true })
}
