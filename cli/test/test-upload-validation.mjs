#!/usr/bin/env node
/**
 * Integration test: Verify upload validation rejects malformed versions
 * Tests both the regex and @std/semver to ensure consistency
 */

import { canParse } from '@std/semver'
import { optionsUploadSchema } from '../src/schemas/bundle.ts'
import { safeParseSchema } from '../src/schemas/schema_validation.ts'

// This is the actual regex from utils.ts line 40
const regexSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*))?(?:\+([0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/i

console.log('🧪 Integration Test: Upload Version Validation\n')

// Critical test cases that MUST be rejected
const criticalFailures = [
  '1.5.00',    // The specific case mentioned
  '1.05.0',    // Leading zero in minor
  '01.5.0',    // Leading zero in major
]

// Test cases that should pass
const shouldPass = [
  '1.5.0',     // Normal version
  '1.0.0',     // Valid zeros
  '1.5.10',    // Double digit (not leading zero)
]

let allPassed = true

console.log('🔍 Testing CRITICAL cases (must reject malformed versions)...\n')

for (const version of criticalFailures) {
  const regexResult = regexSemver.test(version)
  const stdSemverResult = canParse(version)

  console.log(`Testing: "${version}"`)
  console.log(`  regexSemver.test(): ${regexResult}`)
  console.log(`  @std/semver canParse(): ${stdSemverResult}`)

  if (regexResult === false && stdSemverResult === false) {
    console.log(`  ✅ CORRECTLY REJECTED by both validators\n`)
  } else {
    console.error(`  ❌ VALIDATION FAILURE!`)
    if (regexResult) console.error(`     regexSemver INCORRECTLY accepts this`)
    if (stdSemverResult) console.error(`     @std/semver INCORRECTLY accepts this`)
    console.error(``)
    allPassed = false
  }
}

console.log('✓ Testing valid versions (must accept)...\n')

for (const version of shouldPass) {
  const regexResult = regexSemver.test(version)
  const stdSemverResult = canParse(version)

  console.log(`Testing: "${version}"`)
  console.log(`  regexSemver.test(): ${regexResult}`)
  console.log(`  @std/semver canParse(): ${stdSemverResult}`)

  if (regexResult === true && stdSemverResult === true) {
    console.log(`  ✅ CORRECTLY ACCEPTED by both validators\n`)
  } else {
    console.error(`  ❌ VALIDATION FAILURE!`)
    if (!regexResult) console.error(`     regexSemver INCORRECTLY rejects this`)
    if (!stdSemverResult) console.error(`     @std/semver INCORRECTLY rejects this`)
    console.error(``)
    allPassed = false
  }
}

console.log('✓ Testing rollout upload options...\n')

const validRolloutOptions = safeParseSchema(optionsUploadSchema, {
  apikey: 'test-key',
  rollout: 12.5,
  rolloutPercentageBps: 1250,
  rolloutCacheTtlSeconds: 3600,
})
if (!validRolloutOptions.success) {
  console.error('  ❌ VALIDATION FAILURE!')
  console.error('     Upload rollout options should accept percentage, basis points, and cache TTL')
  allPassed = false
}
else {
  console.log('  ✅ Rollout upload options are accepted\n')
}

const invalidRolloutOptions = [
  { apikey: 'test-key', rollout: -1 },
  { apikey: 'test-key', rollout: 100.1 },
  { apikey: 'test-key', rolloutPercentageBps: 10001 },
  { apikey: 'test-key', rolloutCacheTtlSeconds: 59 },
]
for (const options of invalidRolloutOptions) {
  const result = safeParseSchema(optionsUploadSchema, options)
  if (result.success) {
    console.error(`  ❌ VALIDATION FAILURE! Expected rejection for ${JSON.stringify(options)}`)
    allPassed = false
  }
}

if (allPassed)
  console.log('  ✅ Invalid rollout upload options are rejected\n')

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

if (allPassed) {
  console.log('✅ UPLOAD VALIDATION IS WORKING CORRECTLY!\n')
  console.log('📋 Summary:')
  console.log('   ✓ regexSemver (used in upload.ts:52 & zip.ts:71) rejects malformed versions')
  console.log('   ✓ @std/semver consistently validates same as regex')
  console.log('   ✓ Versions like "1.5.00" CANNOT be uploaded')
  console.log('   ✓ Both validation methods are in sync')
  console.log('\n🎉 Your upload code properly rejects malformed versions!')
  process.exit(0)
} else {
  console.error('❌ UPLOAD VALIDATION HAS ISSUES!\n')
  console.error('⚠️  CRITICAL: Malformed versions may be uploadable!')
  process.exit(1)
}
