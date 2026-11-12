#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const bundlePath = join(process.cwd(), 'dist', 'index.js')

if (!existsSync(bundlePath)) {
  console.error('dist/index.js not found. Run "bun run build" first.')
  process.exit(1)
}

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`${label} timed out after ${ms}ms`))
  }, ms)
  promise.then(
    (value) => {
      clearTimeout(timer)
      resolve(value)
    },
    (error) => {
      clearTimeout(timer)
      reject(error)
    },
  )
})

const ciPathPatterns = [
  /\/home\/runner\/work\//g,
  /\/Users\/runner\//g,
  /C:\\\\actions-runner\\\\/g,
  /\/opt\/actions-runner\//g,
  /\/github\/workspace\//g,
]

let stderrOutput = ''

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundlePath, 'mcp'],
  stderr: 'pipe',
})

if (transport.stderr) {
  transport.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString()
  })
}

const client = new Client({ name: 'capgo-mcp-test', version: '0.0.0' })

try {
  await withTimeout(client.connect(transport), 10000, 'MCP connect')

  const toolsResult = await withTimeout(client.listTools({}), 10000, 'MCP tools/list')
  const tools = toolsResult?.tools ?? []

  if (tools.length === 0) {
    throw new Error('MCP server returned no tools')
  }

  const toolNames = new Set(tools.map(tool => tool.name))
  // Architectural boundary: every registered tool needs local files, credentials,
  // a local process, or a persisted onboarding session. Cloud APIs live on hosted MCP.
  const requiredTools = [
    'capgo_set_project_dir', 'capgo_upload_bundle', 'capgo_check_compatibility',
    'capgo_doctor', 'capgo_probe', 'capgo_generate_encryption_keys',
    'capgo_request_build', 'capgo_login', 'capgo_whoami', 'capgo_logout',
    'capgo_star_repository', 'capgo_star_all_repositories',
    'start_capgo_builder_onboarding', 'capgo_builder_onboarding_next_step', 'capgo_builder_onboarding_explain',
    'start_capgo_live_update_onboarding', 'capgo_live_update_onboarding_next_step', 'capgo_live_update_onboarding_explain',
    'start_capgo_build', 'capgo_build_wait', 'capgo_build_logs', 'cancel_capgo_build',
    'capgo_builder_credentials_manage',
  ]
  const missing = requiredTools.filter(name => !toolNames.has(name))
  if (missing.length > 0) {
    throw new Error(`Missing MCP tools: ${missing.join(', ')}`)
  }

  const unexpected = tools.filter(tool => !requiredTools.includes(tool.name))
  if (unexpected.length)
    throw new Error(`Unexpected local MCP tools: ${unexpected.map(tool => tool.name).join(', ')}`)

  for (const tool of tools) {
    for (const field of ['projectDir', 'cwd']) {
      if (tool.inputSchema.properties[field]?.type !== 'string')
        throw new Error(`${tool.name} must support local project selection through ${field}`)
    }
  }

  for (const pattern of ciPathPatterns) {
    if (pattern.test(stderrOutput)) {
      throw new Error(`MCP stderr contains hardcoded CI paths: ${stderrOutput}`)
    }
  }

  if (stderrOutput.includes('ENOENT') && stderrOutput.includes('node_modules/@capacitor/cli')) {
    throw new Error(`MCP stderr indicates @capacitor/cli path error: ${stderrOutput}`)
  }

  console.log('✅ MCP server responds and tools are listed')
}
catch (error) {
  console.error('❌ MCP test failed')
  console.error(error)
  if (stderrOutput) {
    console.error('--- MCP stderr ---')
    console.error(stderrOutput.trim())
  }
  process.exit(1)
}
finally {
  try {
    await transport.close()
  }
  catch {
    // Ignore cleanup errors
  }
}
