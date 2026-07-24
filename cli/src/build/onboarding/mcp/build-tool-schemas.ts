import { z } from 'zod'

export const startCapgoBuildInputSchema = z.object({
  platform: z.enum(['ios', 'android']).describe('The platform to build: "ios" or "android".'),
})

export const capgoBuildWaitInputSchema = z.object({
  job_id: z.string().describe('The job_id returned by start_capgo_build.'),
  timeout_seconds: z.number().int().min(1).max(59).describe('How long to wait this call, in seconds. Default 40, maximum 59 (kept under the MCP tool-call timeout). Pass a larger value to wait longer in one call; the build keeps running regardless.').optional(),
})

export const capgoBuildLogsInputSchema = z.object({
  job_id: z.string().describe('The job_id returned by start_capgo_build.'),
  cursor: z.number().int().min(0).describe('Where to read from. Pass 0 the first time, then the next_cursor from the previous call to get only new lines.').optional(),
})

export const cancelCapgoBuildInputSchema = z.object({
  job_id: z.string().describe('The job_id returned by start_capgo_build.'),
})
