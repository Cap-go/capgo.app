import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import { PLUGIN_DIR, validateOpenAiPlugin } from '../scripts/build-openai-plugin.ts'
import { MCP_TOOLS } from '../supabase/functions/_backend/mcp/tools.ts'

describe('plugin package for OpenAI', () => {
  it('passes the submission manifest checks', () => {
    expect(validateOpenAiPlugin()).toEqual([])
  })

  it('points at the hosted MCP server', () => {
    const mcp = JSON.parse(readFileSync(join(PLUGIN_DIR, 'mcp.json'), 'utf8'))
    expect(mcp.mcpServers.capgo).toEqual({ type: 'streamable-http', url: 'https://api.capgo.app/mcp' })
  })

  it('only references tools the MCP server exposes', () => {
    const toolNames = new Set(MCP_TOOLS.map(tool => tool.name))
    const skillsDir = join(PLUGIN_DIR, 'skills')
    for (const skill of readdirSync(skillsDir)) {
      const text = readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8')
      for (const [name] of text.matchAll(/capgo_[a-z_]+/g))
        expect(toolNames, `${skill} references ${name}`).toContain(name)
    }
  })
})

describe('domain verification for OpenAI', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 404 while no challenge token is configured', async () => {
    vi.stubEnv('OPENAI_APPS_CHALLENGE_TOKEN', '')
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/.well-known/openai-apps-challenge'))
    expect(response.status).toBe(404)
  })

  it('serves the challenge token as plain text', async () => {
    vi.stubEnv('OPENAI_APPS_CHALLENGE_TOKEN', ' token-123 ')
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/.well-known/openai-apps-challenge'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
    await expect(response.text()).resolves.toBe('token-123')
  })
})
