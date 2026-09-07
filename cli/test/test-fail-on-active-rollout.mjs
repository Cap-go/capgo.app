#!/usr/bin/env node
/**
 * Unit tests for `--fail-on-active-rollout` and channel-link messaging helpers.
 */
import assert from 'node:assert/strict'
import {
  formatFailOnActiveRolloutMessage,
  formatStableChannelLinkSuccess,
  hasActiveRollout,
  isStableChannelLinkUpload,
  shouldFailOnActiveRollout,
} from '../src/bundle/upload-channel-link.ts'
import { checkValidOptions } from '../src/bundle/upload.ts'

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

console.log('🧪 Testing hasActiveRollout...\n')

test('active rollout requires rollout_enabled and rollout_version', () => {
  assert.equal(hasActiveRollout({ rollout_enabled: true, rollout_version: 42 }), true)
  assert.equal(hasActiveRollout({ rollout_enabled: true, rollout_version: null }), false)
  assert.equal(hasActiveRollout({ rollout_enabled: false, rollout_version: 42 }), false)
  assert.equal(hasActiveRollout(null), false)
})

console.log('\n🧪 Testing isStableChannelLinkUpload...\n')

test('stable link upload excludes rollout flags', () => {
  assert.equal(isStableChannelLinkUpload({}), true)
  assert.equal(isStableChannelLinkUpload({ rollout: 10 }), false)
  assert.equal(isStableChannelLinkUpload({ rolloutPercentageBps: 1000 }), false)
  assert.equal(isStableChannelLinkUpload({ rolloutAdvance: true }), false)
})

console.log('\n🧪 Testing shouldFailOnActiveRollout...\n')

test('flag off never fails even with active rollout', () => {
  assert.equal(shouldFailOnActiveRollout(
    { failOnActiveRollout: false },
    { rollout_enabled: true, rollout_version: 1 },
  ), false)
})

test('flag on fails for stable link against active rollout', () => {
  assert.equal(shouldFailOnActiveRollout(
    { failOnActiveRollout: true },
    { rollout_enabled: true, rollout_version: 1 },
  ), true)
})

test('flag on does not fail when using --rollout', () => {
  assert.equal(shouldFailOnActiveRollout(
    { failOnActiveRollout: true, rollout: 25 },
    { rollout_enabled: true, rollout_version: 1 },
  ), false)
})

test('flag on does not fail when using --rollout-advance', () => {
  assert.equal(shouldFailOnActiveRollout(
    { failOnActiveRollout: true, rolloutAdvance: true },
    { rollout_enabled: true, rollout_version: 1 },
  ), false)
})

console.log('\n🧪 Testing channel-link success messages...\n')

test('stable link success mentions channel and bundle', () => {
  assert.match(
    formatStableChannelLinkSuccess('production', '1.2.3', false),
    /Linked @1\.2\.3 to channel "production" as stable\./,
  )
})

test('stable link success mentions cleared rollout', () => {
  assert.match(
    formatStableChannelLinkSuccess('production', '1.2.3', true),
    /cleared the active progressive rollout/,
  )
})

test('fail message points at rollout flags and opt-out', () => {
  const message = formatFailOnActiveRolloutMessage('production')
  assert.match(message, /--rollout/)
  assert.match(message, /--rollout-advance/)
  assert.match(message, /--fail-on-active-rollout/)
})

console.log('\n🧪 Testing checkValidOptions guard...\n')

test('--fail-on-active-rollout with --dry-upload is rejected', () => {
  assert.throws(
    () => checkValidOptions({ failOnActiveRollout: true, dryUpload: true }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /--fail-on-active-rollout/)
      assert.match(error.message, /--dry-upload/)
      return true
    },
  )
})

test('--fail-on-active-rollout alone is accepted', () => {
  assert.doesNotThrow(() => checkValidOptions({ failOnActiveRollout: true }))
})

if (failures > 0) {
  console.error(`\n❌ ${failures} fail-on-active-rollout test(s) failed`)
  process.exit(1)
}

console.log('\n✅ fail-on-active-rollout helpers and guards are correct')
