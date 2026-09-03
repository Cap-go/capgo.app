#!/usr/bin/env node
/**
 * Unit tests for the pure `--fail-on-incompatible` gate decision.
 *
 * `shouldBlockIncompatibleUpload` is the side-effect-free helper that decides
 * whether an incompatible upload must be aborted (exit non-zero) instead of
 * uploaded. The gate in `uploadBundleInternal` is driven by this function so the
 * matrix below is the tested source of truth.
 */
import assert from 'node:assert/strict'
import { shouldBlockIncompatibleUpload } from '../src/bundle/builder-cta.ts'
import { checkValidOptions } from '../src/bundle/upload.ts'
import { rejectOrAcceptIncompatibleChannelBundle } from '../src/channel/set.ts'

let failures = 0

function test(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

console.log('🧪 Testing shouldBlockIncompatibleUpload...\n')

// --- The flag is off: never block (current behavior preserved) ---

test('compatible bundle is never blocked', () => {
  assert.equal(shouldBlockIncompatibleUpload({
    incompatible: false,
    failOnIncompatible: true,
    interactive: false,
    builderAction: 'continue',
  }), false)
})

test('incompatible without the flag is not blocked (current behavior)', () => {
  assert.equal(shouldBlockIncompatibleUpload({
    incompatible: true,
    failOnIncompatible: false,
    interactive: false,
    builderAction: 'continue',
  }), false)
})

test('incompatible without the flag is not blocked even in an interactive decline', () => {
  assert.equal(shouldBlockIncompatibleUpload({
    incompatible: true,
    failOnIncompatible: false,
    interactive: true,
    builderAction: 'continue',
  }), false)
})

// --- The flag is on + incompatible ---

// Covers the helper's `interactive: false` branch for completeness. In
// production the non-interactive (CI) path does not actually reach
// `shouldBlockIncompatibleUpload`: it is guarded directly in
// `uploadBundleInternal` (`if (options.failOnIncompatible && !interactive)
// uploadFailIncompatible(...)`) before `maybePromptBuilderCta` runs.
test('incompatible + flag + CI (non-interactive) blocks', () => {
  assert.equal(shouldBlockIncompatibleUpload({
    incompatible: true,
    failOnIncompatible: true,
    interactive: false,
    builderAction: 'continue',
  }), true)
})

test('incompatible + flag + interactive + declined build blocks', () => {
  assert.equal(shouldBlockIncompatibleUpload({
    incompatible: true,
    failOnIncompatible: true,
    interactive: true,
    builderAction: 'continue',
  }), true)
})

test('incompatible + flag + interactive + accepted native build does NOT block', () => {
  assert.equal(shouldBlockIncompatibleUpload({
    incompatible: true,
    failOnIncompatible: true,
    interactive: true,
    builderAction: 'launch-build',
  }), false)
})

test('incompatible + flag + interactive + accepted onboarding does NOT block', () => {
  assert.equal(shouldBlockIncompatibleUpload({
    incompatible: true,
    failOnIncompatible: true,
    interactive: true,
    builderAction: 'launch-onboarding',
  }), false)
})

// --- Defensive: a non-incompatible result with any action stays unblocked ---

test('compatible with accepted build is not blocked', () => {
  assert.equal(shouldBlockIncompatibleUpload({
    incompatible: false,
    failOnIncompatible: true,
    interactive: true,
    builderAction: 'launch-build',
  }), false)
})

console.log('\n🧪 Testing checkValidOptions mutual-exclusion guard...\n')

// --- `--fail-on-incompatible` + `--ignore-metadata-check` are mutually exclusive ---

test('--fail-on-incompatible together with --ignore-metadata-check is rejected', () => {
  assert.throws(
    () => checkValidOptions({ failOnIncompatible: true, ignoreMetadataCheck: true }),
    (error) => {
      assert.ok(error instanceof Error, 'expected an Error to be thrown')
      assert.match(error.message, /--fail-on-incompatible/, 'message should mention --fail-on-incompatible')
      assert.match(error.message, /--ignore-metadata-check/, 'message should mention --ignore-metadata-check')
      return true
    },
  )
})

test('--fail-on-incompatible alone does not trigger the conflict', () => {
  assert.doesNotThrow(() => checkValidOptions({ failOnIncompatible: true }))
})

test('--ignore-metadata-check alone does not trigger the conflict', () => {
  assert.doesNotThrow(() => checkValidOptions({ ignoreMetadataCheck: true }))
})

test('--accept-incompatible together with --fail-on-incompatible is rejected', () => {
  assert.throws(
    () => checkValidOptions({ acceptIncompatible: true, failOnIncompatible: true }),
    (error) => {
      assert.ok(error instanceof Error, 'expected an Error to be thrown')
      assert.match(error.message, /--accept-incompatible/, 'message should mention --accept-incompatible')
      assert.match(error.message, /--fail-on-incompatible/, 'message should mention --fail-on-incompatible')
      return true
    },
  )
})

test('--accept-incompatible together with --ignore-metadata-check is rejected', () => {
  assert.throws(
    () => checkValidOptions({ acceptIncompatible: true, ignoreMetadataCheck: true }),
    (error) => {
      assert.ok(error instanceof Error, 'expected an Error to be thrown')
      assert.match(error.message, /--accept-incompatible/, 'message should mention --accept-incompatible')
      assert.match(error.message, /--ignore-metadata-check/, 'message should mention --ignore-metadata-check')
      return true
    },
  )
})

test('--accept-incompatible alone does not trigger a conflict', () => {
  assert.doesNotThrow(() => checkValidOptions({ acceptIncompatible: true }))
})

test('--rollout-advance with --dry-upload is rejected', () => {
  assert.throws(
    () => checkValidOptions({ rolloutAdvance: true, dryUpload: true }),
    (error) => {
      assert.ok(error instanceof Error, 'expected an Error to be thrown')
      assert.match(error.message, /--rollout-advance/, 'message should mention --rollout-advance')
      return true
    },
  )
})

test('--rollout-advance alone does not trigger a dry-upload conflict', () => {
  assert.doesNotThrow(() => checkValidOptions({ rolloutAdvance: true }))
})

console.log('\n🧪 Testing rejectOrAcceptIncompatibleChannelBundle...\n')

test('channel set throws when incompatible and not accepted', () => {
  assert.throws(
    () => rejectOrAcceptIncompatibleChannelBundle({
      silent: true,
      acceptIncompatible: false,
      incompatible: true,
      finalCompatibility: [],
      heading: 'nope',
      errorMessage: 'Bundle is not compatible with production channel',
    }),
    /Bundle is not compatible with production channel/,
  )
})

test('channel set continues when incompatible and accepted', () => {
  assert.doesNotThrow(() => rejectOrAcceptIncompatibleChannelBundle({
    silent: true,
    acceptIncompatible: true,
    incompatible: true,
    finalCompatibility: [],
    heading: 'nope',
    errorMessage: 'Bundle is not compatible with production channel',
  }))
})

test('channel set continues when compatible', () => {
  assert.doesNotThrow(() => rejectOrAcceptIncompatibleChannelBundle({
    silent: true,
    incompatible: false,
    finalCompatibility: [],
    heading: 'nope',
    errorMessage: 'nope',
  }))
})

if (failures > 0) {
  console.error(`\n❌ ${failures} fail-on-incompatible test(s) failed`)
  process.exit(1)
}

console.log('\n✅ shouldBlockIncompatibleUpload gate decision and checkValidOptions guard are correct')
