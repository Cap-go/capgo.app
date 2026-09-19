import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadConfigTarget } from '../src/config/index.ts'

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(cliRoot, '.capgo-ts7-config-'))

function writeTypescript7Stub(dir) {
  const typescriptDir = join(dir, 'node_modules', 'typescript')
  mkdirSync(typescriptDir, { recursive: true })
  writeFileSync(join(typescriptDir, 'package.json'), JSON.stringify({
    name: 'typescript',
    version: '7.0.2',
    main: 'index.js',
  }))
  // TypeScript 7's default export no longer has transpileModule / ModuleKind.
  writeFileSync(join(typescriptDir, 'index.js'), `'use strict'
module.exports = { version: '7.0.2', versionMajorMinor: '7.0' }
`)
}

try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'ts7-capacitor-app',
    private: true,
    dependencies: {
      typescript: '7.0.2',
    },
  }))
  writeTypescript7Stub(root)
  const configPath = join(root, 'capacitor.config.ts')
  writeFileSync(configPath, `export default {
  appId: 'com.example.ts7',
  appName: 'TS7 app',
  webDir: 'www',
}
`)

  const ts7 = createRequire(join(root, 'package.json'))('typescript')
  assert.equal(ts7.version, '7.0.2')
  assert.equal(ts7.transpileModule, undefined)
  assert.equal(ts7.ModuleKind, undefined)

  const previousCwd = process.cwd()
  try {
    process.chdir(root)
    const loaded = await loadConfig()
    assert.equal(loaded.config.appId, 'com.example.ts7')
    assert.equal(loaded.config.appName, 'TS7 app')
    assert.equal(loaded.config.webDir, 'www')
    assert.equal(loaded.path, configPath)

    const targeted = await loadConfigTarget(configPath)
    assert.equal(targeted.appId, 'com.example.ts7')
    assert.equal(targeted.webDir, 'www')
  }
  finally {
    process.chdir(previousCwd)
  }
}
finally {
  if (existsSync(root))
    rmSync(root, { recursive: true, force: true })
}
