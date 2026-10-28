import type { PgClient } from '../utils/pg.ts'
import type { Database } from '../utils/supabase.types.ts'
import { z } from 'zod'
import { syncBentoSubscriberTags } from '../utils/bento.ts'
import { syncBentoFirstOrgOnRoleBindingWrite } from '../utils/bento_first_org.ts'
import { BRES, createHono, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { version } from '../utils/version.ts'

export const app = createHono('', version)

app.post('/', middlewareAPISecret, triggerValidator('role_bindings', ['INSERT', 'UPDATE']), async (c) => {
  const record = c.get('webhookBody') as Partial<Database['public']['Tables']['role_bindings']['Row']>
  const bindingId = z.uuid().safeParse(record.id)
  if (!bindingId.success)
    throw simpleError('invalid_payload', 'Invalid role binding id', { id: record.id })

  await syncBentoFirstOrgOnRoleBindingWrite(c, bindingId.data)

  // Stop Invite-to-org Bento reminders after accept.
  if (record.reason === 'Accepted invitation' && record.principal_id) {
    let user: { email: string } | undefined
    let pg: PgClient | undefined
    try {
      pg = await getPgClient(c)
      user = (await pg.query<{ email: string }>('SELECT email FROM public.users WHERE id = $1', [record.principal_id])).rows[0]
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'invite accepted user lookup failed', userId: record.principal_id, error })
    }
    finally {
      if (pg)
        closeClient(c, pg)
    }
    if (user?.email) {
      await syncBentoSubscriberTags(c, {
        email: user.email.trim().toLowerCase(),
        segments: ['org:invite_accepted'],
        deleteSegments: [],
      })
    }
  }

  return c.json(BRES)
})
