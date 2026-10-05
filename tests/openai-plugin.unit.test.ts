import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import { PLUGIN_DIR, validateOpenAiPlugin } from '../scripts/build-openai-plugin.ts'
import { MCP_TOOLS } from '../supabase/functions/_backend/mcp/tools.ts'

describe('plugin package for OpenAI', () => {
  it('passes the submission manifest checks', () => {
    expect(validateOpenAiPlugin()).toEqual([])
  })

  it('rejects blank or multiline names, assets outside the package, non-PNG icons and invalid URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capgo-openai-plugin-'))
    try {
      cpSync(PLUGIN_DIR, dir, { recursive: true })
      writeFileSync(join(dir, 'assets', 'broken.png'), 'not a png')
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
      const ui = manifest.extensions['com.openai'].interface
      ui.logo = './assets/../README.md'
      ui.composerIcon = './assets/broken.png'
      ui.displayName = '  '
      ui.shortDescription = 'Live updates\nfor apps'
      ui.websiteURL = 'https://?'
      ui.supportURL = 'https://user:secret@capgo.app/support'
      ui.defaultPrompt = 'List my Capgo apps'
      ui.screenshots = './assets/logo.png'
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))

      expect(validateOpenAiPlugin(dir)).toEqual([
        'displayName must be a single non-blank line',
        'shortDescription must be a single non-blank line',
        'websiteURL must be an https URL',
        'supportURL must be an https URL',
        'logo must point to a non-hidden file under ./assets/ so it is packaged',
        'composerIcon must be a valid PNG file',
        'screenshots must be an array of paths',
      ])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.text()).resolves.toBe('token-123')
  })
})
