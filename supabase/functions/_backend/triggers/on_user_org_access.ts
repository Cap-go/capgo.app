import type { Database } from '../utils/supabase.types.ts'
import { z } from 'zod'
import { syncBentoFirstOrgOnRoleBindingWrite } from '../utils/bento_first_org.ts'
import { BRES, createHono, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { version } from '../utils/version.ts'

export const app = createHono('', version)

app.post('/', middlewareAPISecret, triggerValidator('role_bindings', ['INSERT', 'UPDATE']), async (c) => {
  const record = c.get('webhookBody') as Partial<Database['public']['Tables']['role_bindings']['Row']>
  const bindingId = z.uuid().safeParse(record.id)
  if (!bindingId.success)
    throw simpleError('invalid_payload', 'Invalid role binding id', { id: record.id })

  await syncBentoFirstOrgOnRoleBindingWrite(c, bindingId.data)
  return c.json(BRES)
})
