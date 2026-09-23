import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { supabaseClient } from '../utils/supabase.ts'

function getAuthedSupabase(c: Parameters<typeof supabaseClient>[0]) {
  const authorization = c.get('authorization')
  if (!authorization)
    throw simpleError('not_authorized', 'Not authorized')
  return supabaseClient(c, authorization)
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/', middlewareAuth, async (c) => {
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('get_orgs_v7')

  if (error)
    throw simpleError('orgs_list_error', error.message)

  return c.json(data ?? [])
})
