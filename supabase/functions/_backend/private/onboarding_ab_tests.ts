import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { getOrCreateUserABTests } from '../utils/ab_tests.ts'
import { quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth(), async (c) => {
  const userId = c.get('auth')?.userId
  if (!userId)
    quickError(401, 'unauthorized', 'Unauthorized')

  const assignments = await getOrCreateUserABTests(c, userId)
  return c.json({ assignments })
})
