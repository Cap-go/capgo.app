#!/usr/bin/env node
import process from 'node:process'

console.log('🧪 Testing MCP server instructions...\n')

const { buildServerInstructions } = await import('../src/mcp/instructions.ts')

const MAX_LEN = 512

let pass = 0
let fail = 0
async function test(name, fn) {
  try { console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }

const combos = [
  { onboardingEnabled: false, liveUpdateEnabled: false },
  { onboardingEnabled: true, liveUpdateEnabled: false },
  { onboardingEnabled: false, liveUpdateEnabled: true },
  { onboardingEnabled: true, liveUpdateEnabled: true },
]

await test('all four variants describe Capgo and stay under 512 chars', async () => {
  for (const opts of combos) {
    const text = buildServerInstructions(opts)
    ok(/capgo/i.test(text))
    ok(text.includes('@capacitor/core'))
    ok(text.includes('absolute app path before installing dependencies'))
    ok(text.length <= MAX_LEN, `len ${text.length} for ${JSON.stringify(opts)}`)
    if (!opts.onboardingEnabled)
      ok(!text.includes('start_capgo_builder_onboarding'))
    if (!opts.liveUpdateEnabled)
      ok(!text.includes('start_capgo_live_update_onboarding'))
    if (opts.onboardingEnabled)
      ok(text.includes('start_capgo_builder_onboarding'))
    if (opts.liveUpdateEnabled)
      ok(text.includes('start_capgo_live_update_onboarding'))
  }
})

await test('both enabled: mentions both onboarding entry tools', async () => {
  const text = buildServerInstructions({ onboardingEnabled: true, liveUpdateEnabled: true })
  ok(text.includes('start_capgo_builder_onboarding'))
  ok(text.includes('start_capgo_live_update_onboarding'))
  ok(/FIRST/.test(text))
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)
