import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { syncBentoFirstOrgOnRoleBindingWrite } from '../utils/bento_first_org.ts'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'

interface RoleBindingWritePayload {
  record?: { id?: string | null } | null
  table?: string
  type?: string
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const payload = await parseBody<RoleBindingWritePayload>(c)
  if (payload.table !== 'role_bindings')
    throw simpleError('table_not_match', 'Not role_bindings', { payload })
  if (payload.type !== 'INSERT' && payload.type !== 'UPDATE')
    throw simpleError('type_not_match', 'Not INSERT or UPDATE', { payload })
  if (!payload.record?.id)
    throw simpleError('invalid_payload', 'Missing role binding id', { payload })

  await syncBentoFirstOrgOnRoleBindingWrite(c, payload.record.id)
  return c.json(BRES)
})
