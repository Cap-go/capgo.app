#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const appSource = readFileSync(
  new URL('../src/build/onboarding/android/ui/app.tsx', import.meta.url),
  'utf8',
)

function sourceBetween(start, end) {
  const startIndex = appSource.indexOf(start)
  const endIndex = appSource.indexOf(end, startIndex)
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`)
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`)
  return appSource.slice(startIndex, endIndex)
}

const handler = sourceBetween(
  "{step === 'keystore-method-select'",
  "{step === 'keystore-explainer'",
)
const guardCheck = handler.indexOf('if (selectFiredRef.current)')
const guardClaim = handler.indexOf('selectFiredRef.current = true')
const stateUpdate = handler.indexOf("setKeystoreMethod('existing')")
const persist = handler.indexOf('persistAndStep(')

assert.notEqual(guardCheck, -1, 'keystore method selection must ignore @inkjs/ui re-fires')
assert.notEqual(guardClaim, -1, 'keystore method selection must claim the per-step guard')
assert.ok(guardCheck < stateUpdate, 're-fire check must happen before the first state update')
assert.ok(guardClaim < persist, 'guard must be claimed before starting the progress write')

console.log('✅ Android keystore method selection is guarded against duplicate progress writes')
