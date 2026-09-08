import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadConfigTarget } from '../src/config/index.ts'

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(cliRoot, '.capgo-native-import-config-'))

const major = Number(process.versions.node.split('.')[0])
const supportsNativeImport = Boolean(process.versions.bun) || (Number.isFinite(major) && major >= 22)
if (!supportsNativeImport) {
  console.log('Skipping native-import config test: requires Bun or Node.js 22+')
  process.exit(0)
}

try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'native-import-capacitor-app',
    private: true,
  }))
  writeFileSync(join(root, 'capacitor-app-id.ts'), `export const appId = 'com.example.native-import'
`)
  writeFileSync(join(root, 'capacitor.config.ts'), `import { appId } from './capacitor-app-id.ts'

export default {
  appId,
  appName: 'Native import app',
  webDir: 'www',
}
`)

  const configPath = join(root, 'capacitor.config.ts')
  const targeted = await loadConfigTarget(configPath)
  assert.equal(targeted.appId, 'com.example.native-import')
  assert.equal(targeted.appName, 'Native import app')
  assert.equal(targeted.webDir, 'www')
}
finally {
  if (existsSync(root))
    rmSync(root, { recursive: true, force: true })
}
