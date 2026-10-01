import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { getTopAppsCF, getTotalAppsByModeCF, getTotalAppsCF } from '../utils/cloudflare.ts'
import { simpleError, useCors } from '../utils/hono.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.get('/', async (c) => {
  const mode = c.req.query('mode') ?? 'capacitor'

  const [countTotal, countCategory, data] = await Promise.all([
    getTotalAppsCF(c),
    getTotalAppsByModeCF(c, mode),
    getTopAppsCF(c, mode, 100),
  ])

  if (!data) {
    throw simpleError('error_unknown', 'Error unknown')
  }

  const total = Number(countTotal ?? 0)
  const totalCategory = Number(countCategory ?? 0)

  return c.json({
    apps: data,
    // share of all store apps that use this framework
    usage: total > 0 ? ((totalCategory * 100) / total).toFixed(2) : '0.00',
  })
})
