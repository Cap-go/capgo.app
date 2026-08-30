#!/usr/bin/env node

import assert from 'node:assert/strict'
import { makeProfileXml } from './prescan/helpers.ts'
import {
  analyzeProvisioningCoverage,
  parseProvisioningMap,
  ProvisioningMapError,
} from '../src/build/ios-provisioning-map.ts'

let passed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`✅ PASSED: ${name}`)
  }
  catch (error) {
    console.error(`❌ FAILED: ${name}`)
    throw error
  }
}

function profile(bundleId, name = 'Test Profile') {
  const xml = makeProfileXml({ bundleId }).replace('<string>Test Profile</string>', `<string>${name}</string>`)
  return Buffer.from(xml).toString('base64')
}

function target(name, bundleId) {
  return { name, bundleId, productType: 'com.apple.product-type.app-extension' }
}

function mapJson(entries) {
  return JSON.stringify(entries)
}

test('distinguishes missing, empty, malformed, and invalid maps', () => {
  for (const [raw, code] of [
    [undefined, 'missing'],
    [mapJson({}), 'empty'],
    ['{broken', 'malformed'],
    [mapJson({ app: { profile: 'not-a-profile', name: 'Wrong' } }), 'invalid'],
  ]) {
    assert.throws(
      () => parseProvisioningMap(raw),
      error => error instanceof ProvisioningMapError && error.code === code,
    )
  }
})

test('canonicalizes legacy and object entries with the embedded profile name', () => {
  const appProfile = profile('com.example.app', 'Canonical App')
  const widgetProfile = profile('com.example.widget', 'Canonical Widget')
  const parsed = parseProvisioningMap(mapJson({
    'com.example.app': appProfile,
    'com.example.widget': { profile: widgetProfile, name: 'Stale name' },
  }))

  assert.deepEqual({ ...parsed }, {
    'com.example.app': { profile: appProfile, name: 'Canonical App' },
    'com.example.widget': { profile: widgetProfile, name: 'Canonical Widget' },
  })
})

test('uses exact map keys for coverage and groups duplicate target bundle IDs', () => {
  const shared = profile('com.example.widget')
  const map = parseProvisioningMap(mapJson({ 'some-other-key': shared }))
  const coverage = analyzeProvisioningCoverage([
    target('Widget One', 'com.example.widget'),
    target('Widget Two', 'com.example.widget'),
  ], map)

  assert.equal(coverage.exact.length, 0)
  assert.deepEqual(coverage.missing, [{ bundleId: 'com.example.widget', targetNames: ['Widget One', 'Widget Two'] }])
})

test('returns unresolved build-setting bundle IDs separately', () => {
  const coverage = analyzeProvisioningCoverage([
    target('Resolved', 'com.example.app'),
    target('Missing setting', '$(WIDGET_BUNDLE_ID)'),
    target('Blank', ''),
  ], parseProvisioningMap(mapJson({ 'com.example.app': profile('com.example.app') })))

  assert.deepEqual(coverage.exact.map(item => item.bundleId), ['com.example.app'])
  assert.deepEqual(coverage.unresolved.map(item => item.name), ['Missing setting', 'Blank'])
  assert.equal(coverage.missing.length, 0)
})

test('matches universal and prefix wildcards only against eligible missing targets', () => {
  const prefix = profile('com.example.*', 'Prefix Wildcard')
  const coverage = analyzeProvisioningCoverage([
    target('Exact App', 'com.example.app'),
    target('Widget', 'com.example.widget'),
    target('Other', 'org.other.extension'),
  ], parseProvisioningMap(mapJson({
    'com.example.app': { profile: profile('com.example.app'), name: 'Exact' },
    wildcard: { profile: prefix, name: 'Ignored' },
  })))

  assert.deepEqual(coverage.exact.map(item => item.bundleId), ['com.example.app'])
  assert.deepEqual(coverage.wildcardReuse?.targets.map(item => item.bundleId), ['com.example.widget'])
  assert.deepEqual(coverage.generation.map(item => item.bundleId), ['org.other.extension'])

  const universal = analyzeProvisioningCoverage(
    [target('Other', 'org.other.extension')],
    parseProvisioningMap(mapJson({ wildcard: profile('*', 'Universal') })),
  )
  assert.deepEqual(universal.wildcardReuse?.targets.map(item => item.bundleId), ['org.other.extension'])
})

test('deduplicates identical wildcard bytes stored under multiple keys', () => {
  const wildcard = profile('com.example.*', 'Shared Wildcard')
  const coverage = analyzeProvisioningCoverage(
    [target('Widget', 'com.example.widget')],
    parseProvisioningMap(mapJson({ first: wildcard, second: { profile: wildcard, name: 'Other' } })),
  )

  assert.equal(coverage.wildcardConflict.length, 0)
  assert.deepEqual(coverage.wildcardReuse?.sourceKeys, ['first', 'second'])
})

test('reports different matching wildcard profiles as an unsupported conflict', () => {
  const coverage = analyzeProvisioningCoverage(
    [target('Widget', 'com.example.widget')],
    parseProvisioningMap(mapJson({
      broad: profile('*', 'Broad'),
      prefix: profile('com.example.*', 'Prefix'),
    })),
  )

  assert.equal(coverage.wildcardReuse, null)
  assert.deepEqual(coverage.wildcardConflict.map(item => item.bundleId), ['com.example.widget'])
  assert.equal(coverage.generation.length, 0)
})

test('does not reuse a wildcard for a target with an exact key', () => {
  const coverage = analyzeProvisioningCoverage(
    [target('App', 'com.example.app')],
    parseProvisioningMap(mapJson({
      'com.example.app': profile('com.example.app', 'Exact'),
      wildcard: profile('*', 'Wildcard'),
    })),
  )

  assert.deepEqual(coverage.exact.map(item => item.bundleId), ['com.example.app'])
  assert.equal(coverage.wildcardReuse, null)
  assert.equal(coverage.missing.length, 0)
})

console.log(`\n✅ iOS provisioning map tests passed (${passed})`)
