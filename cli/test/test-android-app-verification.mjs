import assert from 'node:assert/strict'
import { reconcileAndroidApp } from '../src/build/onboarding/android/app-verification-android.ts'

function t(name, fn) {
  try {
    fn()
    process.stdout.write(`✓ ${name}\n`)
  }
  catch (e) {
    process.stderr.write(`✗ ${name}\n`)
    throw e
  }
}

const app = (packageName, displayName = packageName) => ({ packageName, displayName })

// ─── exact-match ──────────────────────────────────────────────────────────

t('reconcileAndroidApp returns exact-match when the single gradle id is in apps', () => {
  const result = reconcileAndroidApp({
    gradleIds: ['ee.forgr.app'],
    apps: [app('ee.forgr.other'), app('ee.forgr.app', 'My App')],
  })
  assert.deepEqual(result, { kind: 'exact-match', packageName: 'ee.forgr.app' })
})

t('reconcileAndroidApp returns exact-match when exactly one of several gradle ids matches', () => {
  // Several flavors, but only one matches a real Play app → still a clean single match.
  const result = reconcileAndroidApp({
    gradleIds: ['ee.forgr.app.dev', 'ee.forgr.app'],
    apps: [app('ee.forgr.app', 'My App')],
  })
  assert.deepEqual(result, { kind: 'exact-match', packageName: 'ee.forgr.app' })
})

// ─── wrong-build-id ─────────────────────────────────────────────────────────

t('reconcileAndroidApp returns wrong-build-id when apps exist but none match', () => {
  const result = reconcileAndroidApp({
    gradleIds: ['ee.forgr.typo'],
    apps: [app('ee.forgr.app'), app('ee.forgr.other')],
  })
  assert.deepEqual(result, { kind: 'wrong-build-id' })
})

// ─── no-app ─────────────────────────────────────────────────────────────────

t('reconcileAndroidApp returns no-app when there are no apps at all', () => {
  const result = reconcileAndroidApp({
    gradleIds: ['ee.forgr.app'],
    apps: [],
  })
  assert.deepEqual(result, { kind: 'no-app' })
})

t('reconcileAndroidApp returns no-app for multiple gradle ids with no apps', () => {
  const result = reconcileAndroidApp({
    gradleIds: ['ee.forgr.app', 'ee.forgr.app.dev'],
    apps: [],
  })
  assert.deepEqual(result, { kind: 'no-app' })
})

// ─── multi-gradle ────────────────────────────────────────────────────────────

t('reconcileAndroidApp returns multi-gradle when several gradle ids match none of the apps', () => {
  const result = reconcileAndroidApp({
    gradleIds: ['ee.forgr.app', 'ee.forgr.app.dev'],
    apps: [app('ee.forgr.other'), app('ee.forgr.unrelated')],
  })
  assert.deepEqual(result, { kind: 'multi-gradle' })
})

t('reconcileAndroidApp returns multi-gradle when several gradle ids each match an app (ambiguous)', () => {
  // Two gradle ids both matching real apps → no clean single match → force picker.
  const result = reconcileAndroidApp({
    gradleIds: ['ee.forgr.app', 'ee.forgr.app.dev'],
    apps: [app('ee.forgr.app'), app('ee.forgr.app.dev')],
  })
  assert.deepEqual(result, { kind: 'multi-gradle' })
})

// ─── empty inputs ────────────────────────────────────────────────────────────

t('reconcileAndroidApp returns no-app when both gradle ids and apps are empty', () => {
  const result = reconcileAndroidApp({ gradleIds: [], apps: [] })
  assert.deepEqual(result, { kind: 'no-app' })
})

t('reconcileAndroidApp returns wrong-build-id when there are no gradle ids but apps exist', () => {
  // Nothing local to match → the enriched picker (wrong-build-id) lets the user choose.
  const result = reconcileAndroidApp({ gradleIds: [], apps: [app('ee.forgr.app')] })
  assert.deepEqual(result, { kind: 'wrong-build-id' })
})

t('reconcileAndroidApp never exact-matches an empty string against a malformed empty-packageName app', () => {
  // Defensive pairing for the parser's drop-empty-packageName rule: even if a
  // packageName-less row reaches reconcile directly, an empty Gradle id must
  // not "match" it and silently persist an empty package.
  const result = reconcileAndroidApp({ gradleIds: [], apps: [app('')] })
  assert.deepEqual(result, { kind: 'wrong-build-id' })
})

t('reconcileAndroidApp returns wrong-build-id for an empty single gradle id with real apps', () => {
  const result = reconcileAndroidApp({ gradleIds: [''], apps: [app('ee.forgr.app')] })
  assert.deepEqual(result, { kind: 'wrong-build-id' })
})

console.log('OK')
