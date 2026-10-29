import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { sendNotifToOrgMembersOnce } from '../utils/org_email_notifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { backgroundTask } from '../utils/utils.ts'
import { shouldSkipVersionNotifications } from '../utils/version_notifications.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('deploy_history', 'INSERT'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['deploy_history']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id', { record })
  }

  let channel: { public: boolean } | undefined
  let version: { name: string, owner_org: string } | undefined
  const pg = await getPgClient(c)
  try {
    // Check if the channel is public
    try {
      const { rows } = await pg.query<{ public: boolean }>('SELECT public FROM public.channels WHERE id = $1', [record.channel_id])
      if (rows.length !== 1)
        throw new Error('Channel not found')
      channel = rows[0]
    }
    catch (channelError) {
      cloudlog({ requestId: c.get('requestId'), message: 'Error fetching channel', channelError })
      return c.json(BRES)
    }

    if (channel.public) {
      // Get version details for the event
      try {
        const { rows } = await pg.query<{ name: string, owner_org: string }>('SELECT name, owner_org FROM public.app_versions WHERE id = $1', [record.version_id])
        if (rows.length !== 1)
          throw new Error('Version not found')
        version = rows[0]
      }
      catch (versionError) {
        cloudlog({ requestId: c.get('requestId'), message: 'Error fetching version', versionError })
        return c.json(BRES)
      }
    }
  }
  finally {
    closeClient(c, pg)
  }

  // If channel is public, send events
  if (channel?.public && version) {

    if (await shouldSkipVersionNotifications(c, record.app_id, record.version_id, record.id)) {
      cloudlog({ requestId: c.get('requestId'), message: 'Demo or removed deployment, skipping deployment events' })
      return c.json(BRES)
    }

    await sendEventToTracking(c, {
      channel: 'bundle-deployed',
      event: 'Bundle Deployed',
      user_id: version.owner_org,
      groups: { organization: version.owner_org },
      tags: {
        app_id: record.app_id,
        bundle_name: version.name,
        channel_id: record.channel_id,
      },
    })

    await backgroundTask(c, (async () => {
      const pgClient = await getPgClient(c, true)
      const drizzleClient = getDrizzleClient(pgClient)
      try {
        await sendNotifToOrgMembersOnce(c, 'bundle:deployed', 'bundle_deployed', {
          org_id: version.owner_org,
          app_id: record.app_id,
          bundle_name: version.name,
          channel_id: record.channel_id,
          version_id: record.version_id,
        }, version.owner_org, `bundle:deployed:${record.version_id}:${record.channel_id}`, drizzleClient)
      }
      finally {
        closeClient(c, pgClient)
      }
    })())
  }

  return c.json(BRES)
})
