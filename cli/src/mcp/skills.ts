import type { McpServer, ProtocolEra } from '@modelcontextprotocol/server'
import { INVALID_PARAMS, ProtocolError, ResourceNotFoundError } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { getSkillInputSchema, getSkillParamsSchema, listSkillsInputSchema, listSkillsParamsSchema, skillContentSchema, skillSchema } from '../schemas/skills'
import { getSkill, listSkillResources, listSkills, PUBLIC_CATALOG_CACHE, readSkillResource, SKILLS_EXTENSION } from './skill-catalog'

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

function toolResult<T extends Record<string, unknown>>(result: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: result }
}

export function registerSkillTools(server: McpServer, era: ProtocolEra): void {
  server.server.registerCapabilities({
    resources: {},
    ...(era === 'modern' ? { extensions: { [SKILLS_EXTENSION]: {} } } : {}),
  })
  server.server.setRequestHandler('resources/list', () => ({ resources: listSkillResources() }))
  server.server.setRequestHandler('resources/read', ({ params }) => {
    const content = readSkillResource(params.uri)
    if (!content)
      throw new ResourceNotFoundError(params.uri)
    return { contents: [content] }
  })

  if (era === 'modern') {
    server.server.setRequestHandler('skills/list', { params: listSkillsParamsSchema }, ({ cursor }) => {
      if (cursor !== undefined)
        throw new ProtocolError(INVALID_PARAMS, 'The skill catalog has no additional pages. Omit cursor.')
      return { resultType: 'complete', skills: listSkills(), ...PUBLIC_CATALOG_CACHE }
    })
    server.server.setRequestHandler('skills/get', { params: getSkillParamsSchema }, ({ uri }) => {
      const skill = getSkill(uri)
      if (!skill)
        throw new ProtocolError(INVALID_PARAMS, 'Use a skill URI from skills/list.')
      return { resultType: 'complete', skill, ...PUBLIC_CATALOG_CACHE }
    })
  }

  server.registerTool('capgo_list_skills', {
    title: 'List Capgo skills',
    description: 'Discover public Capgo workflow guides for releases, update health, native builds, organizations and CLI usage. Returns skill URIs, frontmatter and file manifests with SHA-256 digests. Read a guide with capgo_get_skill before using its workflow. Works offline without login or a selected project.',
    inputSchema: listSkillsInputSchema,
    outputSchema: z.object({ skills: z.array(skillSchema) }),
    annotations: readAnnotations,
  }, () => toolResult({ skills: listSkills() }))

  server.registerTool('capgo_get_skill', {
    title: 'Read Capgo skill',
    description: 'Read a public Capgo workflow guide or one of its supporting files. Returns skill metadata and the requested file content. Reading instructions does not execute the workflow, grant permissions or bypass confirmation for actions. Works offline without login or a selected project.',
    inputSchema: getSkillInputSchema,
    outputSchema: z.object({ skill: skillSchema, contents: z.array(skillContentSchema) }),
    annotations: readAnnotations,
  }, ({ uri, resourceUri }) => {
    const skill = getSkill(uri)
    const fileUri = resourceUri ?? uri
    const content = skill?.resources.some(file => file.uri === fileUri) ? readSkillResource(fileUri) : undefined
    if (!skill || !content) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Use a skill URI from capgo_list_skills and a file URI from that skill\'s resources manifest.' }],
      }
    }
    return toolResult({ skill, contents: [content] })
  })
}
