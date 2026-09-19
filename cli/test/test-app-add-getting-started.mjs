#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  appGettingStartedUrl,
  formatAppGettingStartedMessage,
  shouldPrintAppGettingStartedUrl,
} from '../src/app/add.ts'
import { defaultHostWeb } from '../src/utils.ts'

console.log('🧪 Testing app add getting-started URL...\n')

const appId = 'com.example.app'
const expectedUrl = `${defaultHostWeb}/app/${appId}/getting-started`

assert.equal(appGettingStartedUrl(appId), expectedUrl)
assert.equal(appGettingStartedUrl(appId, 'https://dashboard.example.com/'), `https://dashboard.example.com/app/${appId}/getting-started`)
assert.equal(
  formatAppGettingStartedMessage(appId),
  `Continue setup at ${expectedUrl}`,
)

assert.equal(shouldPrintAppGettingStartedUrl(defaultHostWeb, false), true)
assert.equal(shouldPrintAppGettingStartedUrl(defaultHostWeb, true), false)
assert.equal(shouldPrintAppGettingStartedUrl('https://dashboard.example.com', true), true)

const appAddSource = readFileSync(new URL('../src/app/add.ts', import.meta.url), 'utf8')
assert.match(appAddSource, /resolveAppGettingStartedMessage\(appId, options\)/)
assert.match(appAddSource, /defaultHostWeb/)

const recoverySource = readFileSync(new URL('../src/recovery/app-id.ts', import.meta.url), 'utf8')
assert.match(recoverySource, /resolveAppGettingStartedMessage\(appId/)

console.log('✅ app add getting-started URL tests passed')
