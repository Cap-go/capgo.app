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

export const listSkillsInputSchema = z.object({})
export const getSkillInputSchema = z.object({
  uri: z.string().min(1).describe('Skill URI from capgo_list_skills, identifying its SKILL.md.'),
  resourceUri: z.string().min(1).optional().describe('Supporting file URI from this skill\'s resources manifest. Omit to read SKILL.md.'),
})
export const listSkillsParamsSchema = z.object({ cursor: z.string().optional() })
export const getSkillParamsSchema = getSkillInputSchema.pick({ uri: true })
