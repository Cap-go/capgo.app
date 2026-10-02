import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { CONSOLE_RPCS, CONSOLE_TABLES } from '../utils/console_query_allowlist.ts'
import { parseBody, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { emptySupabase, supabaseClient } from '../utils/supabase.ts'

const operations = z.enum(['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'overlaps', 'not', 'or', 'filter', 'match', 'order', 'limit', 'range', 'single', 'maybeSingle', 'throwOnError'])
const querySchema = z.object({
  kind: z.enum(['table', 'rpc']),
  name: z.string().min(1).max(100),
  args: z.array(z.unknown()).max(2),
  operations: z.array(z.object({ method: operations, args: z.array(z.unknown()).max(3) })).max(64),
})

export const app = new Hono<MiddlewareKeyVariables>()
app.use('*', useCors)

app.post('/query', async (c) => {
  const parsed = querySchema.safeParse(await parseBody(c))
  if (!parsed.success)
    return quickError(400, 'invalid_query', 'Invalid console query')
  const request = parsed.data
  if (!(request.kind === 'table' ? CONSOLE_TABLES : CONSOLE_RPCS).has(request.name))
    return quickError(403, 'unsupported_query', 'Unsupported console query')

  const authorization = c.req.header('authorization')
  if (authorization) {
    const rejection = await middlewareAuth(c, async () => {})
    if (rejection)
      return rejection
  }
  else if (!(request.kind === 'rpc' && request.name === 'is_not_deleted')) {
    return quickError(401, 'not_authenticated', 'Not authenticated')
  }

  // Always use the caller's authenticated role. Never reconstruct queries with a service key.
  const client = authorization ? supabaseClient(c, c.get('authorization')!) : emptySupabase(c)
  let query: any = request.kind === 'table'
    ? client.from(request.name as any)
    : client.rpc(request.name as any, ...request.args as [any, any])
  for (const operation of request.operations)
    query = query[operation.method](...operation.args)
  const { data, error, count, status } = await query
  return c.json({ data, error, count, status })
})

app.post('/images/upload', middlewareAuth, async (c) => {
  const path = c.req.header('x-image-path')
  if (!path || path.length > 1024)
    return quickError(400, 'invalid_path', 'Invalid image path')
  const file = await c.req.arrayBuffer()
  if (file.byteLength > 5 * 1024 * 1024)
    return quickError(413, 'image_too_large', 'Image must be smaller than 5 MB')
  const client = supabaseClient(c, c.get('authorization')!)
  const result = await client.storage.from('images').upload(path, file, {
    contentType: c.req.header('content-type') ?? 'application/octet-stream',
    upsert: c.req.header('x-image-upsert') === 'true',
  })
  return c.json(result)
})

app.post('/images/sign', middlewareAuth, async (c) => {
  const body = z.object({ path: z.string().min(1).max(1024), expiresIn: z.number().int().min(1).max(604800) }).safeParse(await parseBody(c))
  if (!body.success)
    return quickError(400, 'invalid_body', 'Invalid image request')
  const result = await supabaseClient(c, c.get('authorization')!).storage.from('images').createSignedUrl(body.data.path, body.data.expiresIn)
  return c.json(result)
})

app.post('/images/remove', middlewareAuth, async (c) => {
  const body = z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(20) }).safeParse(await parseBody(c))
  if (!body.success)
    return quickError(400, 'invalid_body', 'Invalid image request')
  const result = await supabaseClient(c, c.get('authorization')!).storage.from('images').remove(body.data.paths)
  return c.json(result)
})

app.get('/events', middlewareAuth, async (c) => {
  const orgId = z.uuid().safeParse(c.req.query('org_id'))
  if (!orgId.success)
    return quickError(400, 'invalid_org', 'Invalid organization')
  const { data, error } = await supabaseClient(c, c.get('authorization')!).from('orgs').select('id').eq('id', orgId.data).maybeSingle()
  if (error || !data)
    return quickError(403, 'not_authorized', 'Not authorized')
  const events = c.env.CONSOLE_EVENTS
  if (!events)
    return quickError(503, 'events_unavailable', 'Console events are unavailable')
  const response = await events.get(events.idFromName(orgId.data)).fetch('https://console-events/subscribe')
  return new Response(response.body as unknown as ReadableStream, { headers: Array.from(response.headers.entries()), status: response.status })
})
