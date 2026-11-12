import { z } from 'zod'

export const skillSchema = z.object({
  uri: z.string(),
  frontmatter: z.object({ name: z.string(), description: z.string() }).catchall(z.unknown()),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number().int().nonnegative() })),
})
export const skillContentSchema = z.object({
  uri: z.string(),
  mimeType: z.string(),
  text: z.string().optional(),
  blob: z.string().optional(),
})

// The CLI and hosted MCP publish the same build-time catalog.
export { getSkill, listSkillResources, listSkills, PUBLIC_CATALOG_CACHE, readSkillResource, SKILLS_EXTENSION } from '../../../../cli/src/mcp/skill-catalog.ts'
