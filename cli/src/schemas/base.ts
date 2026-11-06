import { z } from 'zod'

// ============================================================================
// Base Options Schema
// ============================================================================

export const optionsBaseSchema = z.object({
  apikey: z.string(),
  /** Capgo API base URL (`--api-host`). */
  apiHost: z.string().optional(),
  /** Capgo files API base URL; defaults to apiHost. */
  filesHost: z.string().optional(),
})

export type OptionsBase = z.infer<typeof optionsBaseSchema>
