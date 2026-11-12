import { z } from 'zod'
import catalog from './skills.generated.json' with { type: 'json' }

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
export const PUBLIC_CATALOG_CACHE = { ttlMs: 3_600_000, cacheScope: 'public' } as const

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

const skillsByUri = new Map(catalog.skills.map(skill => [skill.uri, skill]))
const contentsByUri = new Map(catalog.contents.map(content => [content.uri, content]))

export function listSkills() {
  return catalog.skills
}

export function getSkill(uri: string) {
  return skillsByUri.get(uri)
}

export function readSkillResource(uri: string) {
  // Exact catalog lookup only: no filesystem access, URL fetching or path normalization.
  return contentsByUri.get(uri)
}

export function listSkillResources() {
  return catalog.skills.map(skill => ({
    uri: skill.uri,
    name: skill.frontmatter.name,
    description: skill.frontmatter.description,
    mimeType: 'text/markdown',
  }))
}
