import { readFileSync, writeFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('packages/capacitor-notifications/package.json', 'utf8')) as { version?: string }
const version = packageJson.version

if (!version) {
  throw new Error('packages/capacitor-notifications/package.json is missing version')
}

writeFileSync('packages/capacitor-notifications/src/version.ts', `export const PLUGIN_VERSION = '${version}'\n`)
