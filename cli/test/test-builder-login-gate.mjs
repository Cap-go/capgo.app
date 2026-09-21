#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { resolveBuilderCandidateKey } from '../src/build/onboarding/login.ts'

const previousToken = process.env.CAPGO_TOKEN
try {
  process.env.CAPGO_TOKEN = 'env-test-key'
  assert.equal(resolveBuilderCandidateKey(' explicit-test-key '), 'explicit-test-key')
  assert.equal(resolveBuilderCandidateKey('   '), 'env-test-key')
  assert.equal(resolveBuilderCandidateKey(), 'env-test-key')
}
finally {
  if (previousToken === undefined)
    delete process.env.CAPGO_TOKEN
  else
    process.env.CAPGO_TOKEN = previousToken
}

console.log('Builder candidate key precedence passed')
