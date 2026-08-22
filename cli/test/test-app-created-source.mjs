#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setInvocationSource } from '../src/analytics/track.ts'
import { resolveAppCreateSource } from '../src/app/add.ts'
import { detectOnboardingSource, isAiAgentEnvironment } from '../src/init/onboarding-source.ts'

console.log('🧪 Testing App Created source resolution...\n')

const appAddSource = readFileSync(new URL('../src/app/add.ts', import.meta.url), 'utf8')

assert.doesNotMatch(appAddSource, /\bcheckAppExists\b/)
assert.doesNotMatch(appAddSource, /\bensureAppDoesNotExist\b/)
assert.match(appAddSource, /method:\s*'POST'/)
assert.match(appAddSource, /appId === 'io\.ionic\.starter'/)

// explicit onboarding wins
assert.equal(resolveAppCreateSource('onboarding'), 'onboarding')

// no explicit source, CLI context => cli-direct
setInvocationSource('cli')
assert.equal(resolveAppCreateSource(undefined), 'cli-direct')

// no explicit source, MCP context => mcp
setInvocationSource('mcp')
assert.equal(resolveAppCreateSource(undefined), 'mcp')
setInvocationSource('cli')

console.log('✅ App Created source tests passed')

assert.equal(isAiAgentEnvironment({}), false)
assert.equal(isAiAgentEnvironment({ CURSOR_AGENT: '1' }), true)
assert.equal(isAiAgentEnvironment({ CAPGO_ONBOARDING_SOURCE: 'ai' }), true)
assert.equal(isAiAgentEnvironment({ CAPGO_ONBOARDING_SOURCE: 'cli' }), false)

setInvocationSource('mcp')
assert.equal(detectOnboardingSource(), 'mcp')
setInvocationSource('cli')

console.log('✅ Onboarding source detection tests passed')
