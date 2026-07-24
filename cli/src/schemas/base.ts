import { z } from 'zod'

// ============================================================================
// Base Options Schema
// ============================================================================

export const optionsBaseSchema = z.object({
  apikey: z.string(),
  supaHost: z.string().optional(),
  supaAnon: z.string().optional(),
})

export type OptionsBase = z.infer<typeof optionsBaseSchema>
