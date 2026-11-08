import { z } from 'zod'

export const observeSampleResponseSchema = z.object({
  device_id: z.string(),
  action: z.string(),
  version_name: z.string(),
  created_at: z.string(),
  duration_ms: z.number().nonnegative().nullable(),
  route: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
}).passthrough()
