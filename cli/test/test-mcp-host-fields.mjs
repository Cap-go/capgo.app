#!/usr/bin/env bun
/**
 * MCP tools can run with the user's saved API key, so no tool input may choose
 * the host that key is sent to.
 */
import assert from 'node:assert/strict'
import * as schemas from '../src/mcp/tool-schemas.ts'

const blocked = ['apiHost', 'filesHost', 'supaHost', 'supaAnon']
const checked = []
for (const [name, schema] of Object.entries(schemas)) {
  if (!name.startsWith('mcp') || typeof schema?.safeParse !== 'function')
    continue
  const shape = schema.shape ?? schema._zod?.def?.in?.shape ?? schema._def?.schema?.shape
  if (!shape)
    continue
  checked.push(name)
  for (const field of blocked)
    assert.ok(!(field in shape), `${name} must not accept ${field}`)
}
assert.ok(checked.includes('mcpUpdateAppInputSchema'), 'update app schema is checked')
assert.ok(checked.includes('mcpUpdateOrganizationInputSchema'), 'update organization schema is checked')
assert.ok(checked.includes('mcpObserveInputSchema'), 'observe schema is checked')
console.log(`MCP input schemas drop host fields (${checked.length} schemas checked)`)
