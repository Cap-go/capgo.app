#!/usr/bin/env node
import assert from 'node:assert/strict'

const { explainError, guidanceForError, GUIDANCE_HEADING, withErrorGuidance, withGuidedErrorResults } = await import('../src/mcp/error-guidance.ts')
const { buildAppIdTakenMessage } = await import('../src/app/add.ts')

console.log('🧪 Testing MCP error guidance (no dead ends)...\n')

const cases = [
  ['Missing API key, specify a key with --apikey', 'authentication'],
  ['Invalid API key', 'authentication'],
  ['JWT expired', 'authentication'],
  ['Your API key has expired', 'authentication'],
  ['Upload token has expired, restart the upload', 'expired'],
  ['The industrial build failed', 'unexpected'],
  ['No Capgo API key found. Run `npx -y @capgo/cli@latest login` first, then retry this command.', 'authentication'],
  ['org_requires_expiring_key: This organization requires API keys with expiration dates.', 'security_policy'],
  ['Error status 429: rate_limit_exceeded', 'rate_limited'],
  ['need_plan_upgrade: upgrade your plan', 'plan_limit'],
  ['Error status 429: need_plan_upgrade: Cannot request native build, upgrade plan to continue to build', 'plan_limit'],
  ['not_authorized: you cannot access this app', 'permission'],
  ['Missing appId, use --app-id or set it in capacitor.config', 'project'],
  ['Channel production not found for app com.example.app', 'not_found'],
  ['Version 1.0.0 already exists', 'conflict'],
  ['fetch failed: ECONNREFUSED', 'network'],
  ['Invalid semver version: abc', 'fix_input'],
  ['Something exploded', 'unexpected'],
]
for (const [message, kind] of cases) {
  const guidance = guidanceForError(message, 'capgo_test')
  assert.equal(guidance.kind, kind, message)
  assert.ok(guidance.nextSteps.length >= 2, message)
  assert.ok(guidance.nextSteps.join(' ').includes('support@capgo.app'), `${message} has a support escape hatch`)
}

// Already-explained errors are left alone, others get exactly one guidance block.
const taken = buildAppIdTakenMessage('com.example.app')
assert.equal(explainError(taken), taken)
const explained = explainError('Something exploded', 'capgo_test')
assert.equal(explained.split(GUIDANCE_HEADING).length, 2)
assert.equal(explainError(explained), explained)

// Safety net: error results get guidance, throws become guided error results, successes pass through.
const errorResult = await withErrorGuidance('capgo_list_apps', async () => ({ content: [{ type: 'text', text: 'Missing API key' }], isError: true }))()
assert.equal(errorResult.isError, true)
assert.match(errorResult.content[0].text, /How to fix \(authentication\)/)
assert.match(errorResult.content[0].text, /capgo_login/)

const thrown = await withErrorGuidance('capgo_list_apps', async () => { throw new Error('socket hang up') })()
assert.equal(thrown.isError, true)
assert.match(thrown.content[0].text, /capgo_list_apps failed: socket hang up/)
assert.match(thrown.content[0].text, /How to fix \(network\)/)

const empty = await withErrorGuidance('capgo_list_apps', async () => ({ content: [], isError: true }))()
assert.match(empty.content[0].text, /How to fix/)

const success = { content: [{ type: 'text', text: 'ok' }] }
assert.equal(await withErrorGuidance('capgo_list_apps', async () => success)(), success)

// Transport net: SDK-built validation errors get guidance; other messages are untouched.
const sdkError = { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool capgo_list_channels: appId: Invalid input: expected string, received undefined' }], isError: true } }
const guidedSdkError = withGuidedErrorResults(sdkError)
assert.match(guidedSdkError.result.content[0].text, /How to fix \(fix_input\)/)
const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: {} }
assert.equal(withGuidedErrorResults(notification), notification)
const okResponse = { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'ok' }] } }
assert.equal(withGuidedErrorResults(okResponse), okResponse)
assert.equal(withGuidedErrorResults(guidedSdkError), guidedSdkError)

// JSON-RPC errors from the SDK (unknown tool) also get guidance pointing to tools/list.
const unknownTool = withGuidedErrorResults({ jsonrpc: '2.0', id: 5, error: { code: -32602, message: 'MCP error -32602: Tool capgo_nope not found' } })
assert.match(unknownTool.error.message, /How to fix \(not_found\)/)
assert.match(unknownTool.error.message, /tools\/list/)
assert.equal(unknownTool.error.code, -32602)
assert.equal(withGuidedErrorResults(unknownTool), unknownTool)

console.log('✅ MCP error guidance tests passed')
