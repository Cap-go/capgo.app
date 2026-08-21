import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { purgeOnPremCache } from '../utils/cloudflare_cache_purge.ts'
import { isDemoApp } from '../utils/demo.ts'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { sendEmailToOrgMembers } from '../utils/org_email_notifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { backgroundTask } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('app_versions', 'INSERT'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['app_versions']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id', { record })
  }

  let shouldSkipNotifications = false

  if (await isDemoApp(c, record.app_id)) {
    cloudlog({ requestId: c.get('requestId'), message: 'Demo app detected, skipping email notifications' })
    shouldSkipNotifications = true
  }

  const { error: errorUpdate } = await supabaseAdmin(c)
    .from('apps')
    .update({
      last_version: record.name,
    })
    .eq('app_id', record.app_id)
    .eq('owner_org', record.owner_org)
  if (errorUpdate)
    cloudlog({ requestId: c.get('requestId'), message: 'errorUpdate', errorUpdate })

  await backgroundTask(c, purgeOnPremCache(c, record.app_id))

  if (!shouldSkipNotifications) {
    await sendEventToTracking(c, {
      channel: 'bundle-created',
      event: 'Bundle Created',
      user_id: record.owner_org,
      groups: { organization: record.owner_org },
      tags: {
        app_id: record.app_id,
        bundle_name: record.name,
      },
    })
    const pgClient = getPgClient(c, true)
    const drizzleClient = getDrizzleClient(pgClient)
    try {
      await backgroundTask(c, sendEmailToOrgMembers(c, 'bundle:created', 'bundle_created', {
        org_id: record.owner_org,
        app_id: record.app_id,
        bundle_name: record.name,
        bundle_id: record.id,
      }, record.owner_org, drizzleClient))
    }
    finally {
      closeClient(c, pgClient)
    }
  }

  return c.json(BRES)
})
