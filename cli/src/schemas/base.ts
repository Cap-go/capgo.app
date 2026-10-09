import { z } from 'zod'

// ============================================================================
// Base Options Schema
// ============================================================================

export const optionsBaseSchema = z.object({
  apikey: z.string(),
  /** Capgo API base URL; deprecated --supa-host / --supa-anon are folded into it before commands run. */
  apiHost: z.string().optional(),
})

export type OptionsBase = z.infer<typeof optionsBaseSchema>
