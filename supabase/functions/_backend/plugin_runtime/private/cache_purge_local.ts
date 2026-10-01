// Local-only stand-in for Cloudflare purge-by-tag: workerd dev has no zone
// purge API, so triggers/updates_cache_purge posts the tags here and the
// plugin worker deletes the keys it tagged in this isolate.

import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { purgeLocalTaggedKeys } from '../utils/cache.ts'
import { BRES, parseBody, simpleError } from '../utils/hono.ts'
import { getEnv } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', async (c) => {
  if (!getEnv(c, 'ENV_NAME').endsWith('-local'))
    return c.notFound()
  const secret = getEnv(c, 'API_SECRET')
  if (!secret || c.req.header('apisecret') !== secret)
    throw simpleError('invalid_api_secret', 'Invalid API secret')
  const body = await parseBody<{ tags?: unknown } | null>(c)
  const rawTags = body && typeof body === 'object' ? body.tags : undefined
  const tags = Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === 'string') : []
  const deleted = await purgeLocalTaggedKeys(tags)
  return c.json({ ...BRES, deleted })
})
