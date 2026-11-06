import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { timingSafeEqual } from 'hono/utils/buffer'
import { z } from 'zod'
import { BRES, parseBody, quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { getEnv } from '../../utils/utils.ts'

const bodySchema = z.object({
  workers_total: z.number().int().min(0).max(10_000),
  source: z.string().min(1).max(64).optional(),
})

async function assertBuilderApiKey(c: Context<MiddlewareKeyVariables>) {
  const provided = c.req.header('x-api-key') || c.req.header('apikey') || ''
  const expected = getEnv(c, 'BUILDER_API_KEY')
  if (!expected || !provided || !(await timingSafeEqual(provided, expected)))
    throw quickError(401, 'invalid_builder_api_key', 'Invalid builder API key')
}

export async function reportBuilderCapacity(c: Context<MiddlewareKeyVariables>) {
  await assertBuilderApiKey(c)
  const body = await parseBody<z.infer<typeof bodySchema>>(c)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    throw simpleError('invalid_body', 'Invalid capacity body', {
      issues: parsed.error.issues.map(i => i.message),
    })
  }

  // Pool-size history is recorded by the admin dashboard, which polls the
  // builder itself. The report is still authenticated and acknowledged so the
  // builder keeps working until it stops sending it.
  const source = parsed.data.source ?? 'builder'
  cloudlog({
    requestId: c.get('requestId'),
    message: 'builder capacity report',
    workers_total: parsed.data.workers_total,
    source,
  })
  return c.json({ ...BRES, recorded: false, workers_total: parsed.data.workers_total })
}
