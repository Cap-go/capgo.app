#!/usr/bin/env node
import process from 'node:process'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

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
    ok(text.includes('capgo_list_skills'))
    ok(text.includes('capgo_get_skill'))
    ok(text.includes('App tools accept projectDir or cwd: the absolute app path'))
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

await test('build tool guidance matches onboarding tool availability', async () => {
  for (const onboardingEnabled of [false, true]) {
    const serverUrl = new URL('../src/mcp/server.ts', import.meta.url).href
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-e', `globalThis.__CAPGO_MCP_ONBOARDING__ = ${onboardingEnabled}; const { startMcpServer } = await import(${JSON.stringify(serverUrl)}); await startMcpServer()`],
      env: { ...process.env, CAPGO_DISABLE_TELEMETRY: '1' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'capgo-build-guidance-test', version: '0.0.0' })
    try {
      await client.connect(transport)
      const { tools } = await client.listTools({})
      const description = tools.find(tool => tool.name === 'capgo_request_build')?.description ?? ''
      ok(description.includes('generally available Capgo Build'))
      ok(tools.some(tool => tool.name === 'start_capgo_builder_onboarding') === onboardingEnabled)
      ok(description.includes('start_capgo_builder_onboarding') === onboardingEnabled)
      if (!onboardingEnabled)
        ok(description.includes('npx @capgo/cli@latest build init'))
    }
    finally {
      await transport.close()
    }
  }
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)
