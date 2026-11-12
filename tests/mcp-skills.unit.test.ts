import type { McpToolContext, McpToolResult } from '../supabase/functions/_backend/mcp/tools.ts'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { buildMcpSkillCatalog, MCP_SKILL_SOURCES } from '../scripts/generate-mcp-skills.ts'
import { LATEST_LEGACY_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION } from '../supabase/functions/_backend/mcp/metadata.ts'
import { CLIENT_CAPABILITIES_META, PROTOCOL_VERSION_META } from '../supabase/functions/_backend/mcp/modern_protocol.ts'
import { handleJsonRpcMessage, listTools } from '../supabase/functions/_backend/mcp/protocol.ts'
import catalog from '../supabase/functions/_backend/mcp/skills.generated.json'
import { getSkill, listSkills, readSkillResource, SKILLS_EXTENSION } from '../supabase/functions/_backend/mcp/skills.ts'
import { MCP_TOOLS_BY_NAME } from '../supabase/functions/_backend/mcp/tools.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const meta = { [PROTOCOL_VERSION_META]: LATEST_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META]: {} }
const skillUri = 'skill://capgo/ship-live-update/SKILL.md'
function context(): McpToolContext {
  return {
    caller: { userId: 'skill-test-user', apikeyId: 1, apikeyName: 'test', apikeyExpiresAt: null },
    call: vi.fn(async () => { throw new Error('Skill discovery must not call an API') }),
  }
}
const rpc = (method: string, params: Record<string, unknown> = {}, modern = true) => handleJsonRpcMessage({
  jsonrpc: '2.0', id: 1, method, params: { ...(modern ? { _meta: meta } : {}), ...params },
}, context())

describe('published skill catalog', () => {
  it('matches the public sources; regenerate with bun run generate:mcp-skills after editing a skill', async () => {
    expect(await buildMcpSkillCatalog(root)).toEqual(catalog)
    expect(listSkills()).toHaveLength(7)
  })

  it.concurrent.each(listSkills())('serves exact source bytes and digests for $frontmatter.name', async (skill) => {
    const source = MCP_SKILL_SOURCES.find(path => path.endsWith(`/${skill.frontmatter.name}`))!
    const sourceBytes = await readFile(join(root, source, 'SKILL.md'))
    expect(readSkillResource(skill.uri)?.text).toBe(Buffer.from(sourceBytes).toString('utf8'))
    for (const file of skill.resources) {
      const content = readSkillResource(file.uri)!
      const bytes = 'text' in content ? Buffer.from(content.text) : Buffer.from((content as { blob: string }).blob, 'base64')
      expect(file.digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
      expect(file.size).toBe(bytes.length)
    }
  })

  it('includes supporting files byte-for-byte and refuses symlinks', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'capgo-mcp-skills-'))
    try {
      for (const source of MCP_SKILL_SOURCES)
        await cp(join(root, source), join(fixture, source), { recursive: true })
      const references = join(fixture, MCP_SKILL_SOURCES[0], 'references')
      await mkdir(references)
      const bytes = Buffer.from('\uFEFFRésumé\r\n')
      await writeFile(join(references, 'guide.md'), bytes)
      await writeFile(join(references, 'sample.bin'), Buffer.from([0, 255, 128]))
      const generated = await buildMcpSkillCatalog(fixture)
      const guide = generated.contents.find(file => file.uri.endsWith('/references/guide.md'))!
      expect(Buffer.from(guide.text!)).toEqual(bytes)
      expect(generated.contents.find(file => file.uri.endsWith('/references/sample.bin'))?.blob).toBe('AP+A')
      expect(generated.skills.find(skill => skill.frontmatter.name === 'check-update-health')?.resources).toHaveLength(3)
      await symlink(join(root, 'package.json'), join(references, 'private.json'))
      await expect(buildMcpSkillCatalog(fixture)).rejects.toThrow('symlinks are not published')
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

describe('skills over MCP', () => {
  it.concurrent('discovers capabilities and returns manifests without loading instructions', async () => {
    const discovery = await rpc('server/discover')
    expect(discovery?.result).toMatchObject({
      resultType: 'complete', supportedVersions: expect.arrayContaining([LATEST_PROTOCOL_VERSION, LATEST_LEGACY_PROTOCOL_VERSION]),
      capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION]: {} } },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'app.capgo/capgo' } },
      ttlMs: 3_600_000, cacheScope: 'public', instructions: expect.stringContaining('capgo_list_skills'),
    })
    const listing = await rpc('skills/list')
    expect(listing?.result).toMatchObject({ resultType: 'complete', skills: listSkills(), ttlMs: 3_600_000, cacheScope: 'public' })
    expect(JSON.stringify(listing)).not.toContain('Use this workflow when')
  })

  it.concurrent('gets one manifest and reads its instructions separately', async () => {
    expect((await rpc('skills/get', { uri: skillUri }))?.result).toMatchObject({ skill: getSkill(skillUri) })
    expect((await rpc('resources/read', { uri: skillUri }))?.result).toMatchObject({ contents: [readSkillResource(skillUri)], resultType: 'complete' })
  })

  it.concurrent.each(['file:///etc/passwd', 'https://example.com/SKILL.md', 'skill://capgo/ship-live-update/../usage/SKILL.md', 'skill://capgo/%2e%2e/SKILL.md', '__proto__'])('rejects unlisted URI %s', async (uri) => {
    expect((await rpc('skills/get', { uri }))?.error?.code).toBe(-32602)
    expect((await rpc('resources/read', { uri }))?.error?.code).toBe(-32602)
  })

  it.concurrent('rejects incomplete modern metadata and unsupported versions', async () => {
    expect((await rpc('skills/list', {}, false))?.error?.code).toBe(-32602)
    expect((await rpc('skills/list', { _meta: { [PROTOCOL_VERSION_META]: LATEST_PROTOCOL_VERSION } }))?.error?.code).toBe(-32602)
    expect((await rpc('skills/list', { _meta: { ...meta, [PROTOCOL_VERSION_META]: '2099-01-01' } }))?.error).toMatchObject({
      code: -32022, data: { requested: '2099-01-01', supported: expect.arrayContaining([LATEST_PROTOCOL_VERSION]) },
    })
    expect((await rpc('skills/list', { cursor: 'invalid' }))?.error?.code).toBe(-32602)
  })

  it.concurrent('preserves legacy initialization and resource response shapes', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-11-25' }, false)
    expect(init?.result).toMatchObject({ protocolVersion: '2025-11-25', capabilities: { resources: { subscribe: false } } })
    expect(init?.result).not.toHaveProperty('resultType')
    expect(init?.result).not.toHaveProperty('capabilities.extensions')
    expect((await rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION }, false))?.result).toMatchObject({ protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION })
    const listing = await rpc('resources/list', {}, false)
    expect((listing?.result as { resources: unknown[] }).resources).toHaveLength(7)
    const content = (await rpc('resources/read', { uri: skillUri }, false))?.result
    expect(content).toEqual({ contents: [readSkillResource(skillUri)] })
    expect((await rpc('prompts/list', {}, false))?.result).toEqual({ prompts: [] })
  })
})

describe('skills compatibility tools', () => {
  it.concurrent.each(['capgo_list_skills', 'capgo_get_skill'])('%s returns structured results matching its schema without API calls', async (name) => {
    const tool = MCP_TOOLS_BY_NAME.get(name)!
    const ctx = context()
    const result = await tool.run(name === 'capgo_get_skill' ? { uri: skillUri } : {}, ctx)
    expect(ctx.call).not.toHaveBeenCalled()
    expect(tool.outputSchema!.safeParse(result.structuredContent).success).toBe(true)
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    expect(listTools().find(tool => (tool as { name: string }).name === name)).toHaveProperty('outputSchema')
  })

  it.concurrent('loads the same skill through the compatibility tool and standard resource method', async () => {
    const result = (await rpc('tools/call', { name: 'capgo_get_skill', arguments: { uri: skillUri } }, false))?.result as McpToolResult
    expect(result.structuredContent).toEqual({ skill: getSkill(skillUri), contents: [readSkillResource(skillUri)] })
  })

  it.concurrent('rejects files outside the selected skill with actionable guidance', async () => {
    const result = (await rpc('tools/call', {
      name: 'capgo_get_skill', arguments: { uri: skillUri, resourceUri: 'skill://capgo/usage/SKILL.md' },
    }, false))?.result as McpToolResult
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toHaveProperty('how_to_fix')
    expect(result.structuredContent).toBeUndefined()
  })
})
