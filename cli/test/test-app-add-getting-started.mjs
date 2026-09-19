#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  appGettingStartedUrl,
  formatAppGettingStartedMessage,
} from '../src/app/add.ts'
import { defaultHostWeb } from '../src/utils.ts'

console.log('🧪 Testing app add getting-started URL...\n')

const appId = 'com.example.app'
const expectedUrl = `${defaultHostWeb}/app/${appId}/getting-started`

assert.equal(appGettingStartedUrl(appId), expectedUrl)
assert.equal(
  formatAppGettingStartedMessage(appId),
  `Continue setup at ${expectedUrl}`,
)

const appAddSource = readFileSync(new URL('../src/app/add.ts', import.meta.url), 'utf8')
assert.match(appAddSource, /formatAppGettingStartedMessage\(appId\)/)

const recoverySource = readFileSync(new URL('../src/recovery/app-id.ts', import.meta.url), 'utf8')
assert.match(recoverySource, /formatAppGettingStartedMessage\(appId\)/)

console.log('✅ app add getting-started URL tests passed')
