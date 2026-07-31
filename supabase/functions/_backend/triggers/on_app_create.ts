import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import type { BentoTrackingPayload } from '../utils/tracking.ts'
import { eq, or } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { createIfNotExistStoreInfo } from '../utils/cloudflare.ts'
import { purgeOnPremCache } from '../utils/cloudflare_cache_purge.ts'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import * as schema from '../utils/postgres_schema.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { buildOnboardingIntentBentoEventData, parseOrgOnboardingIntent } from '../utils/org_onboarding_intent.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { backgroundTask } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('apps', 'INSERT'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['apps']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id', { record })
  }

  const supabase = supabaseAdmin(c)

  // The app_versions table uses a DB trigger (auto_owner_org_by_app_id) that derives owner_org
  // from apps.app_id. If the app is deleted before this async trigger runs, inserting default
  // versions will fail with a NOT NULL violation. Always re-check that the app still exists.
  const pg = getPgClient(c, true)
  const drizzleClient = getDrizzleClient(pg)
  let appExists = false
  let ownerOrg: string | undefined
  try {
    const rows = await drizzleClient
      .select({ owner_org: schema.apps.owner_org })
      .from(schema.apps)
      .where(or(eq(schema.apps.id, record.id), eq(schema.apps.app_id, record.app_id)))
      .limit(1)
    appExists = rows.length > 0
    ownerOrg = rows[0]?.owner_org ?? undefined
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'Error fetching app owner_org', error, appId: record.id, app_id: record.app_id })
  }
  finally {
    closeClient(c, pg)
  }

  // If the app no longer exists (deleted between INSERT and async trigger processing), skip
  // all side effects. Still validate the org exists to keep the "error cases" contract.
  if (!appExists) {
    ownerOrg = ownerOrg ?? (record.owner_org ?? undefined)
    if (!ownerOrg) {
      cloudlog({ requestId: c.get('requestId'), message: 'App missing and no owner_org in webhook payload, skipping', record })
      return c.json(BRES)
    }

    const { data, error } = await supabase
      .from('orgs')
      .select('*')
      .eq('id', ownerOrg)
      .single()
    if (error || !data) {
      // In prod, INSERT triggers are processed async via PGMQ; the app (and even org)
      // may be deleted before the queued handler runs. If this handler was invoked
      // by the queue consumer, skip instead of retrying forever / alerting.
      const cfId = c.req.header('x-capgo-cf-id')
      if (cfId) {
        cloudlog({
          requestId: c.get('requestId'),
          message: 'App missing and org missing during queued trigger processing, skipping',
          ownerOrg,
          app_id: record.app_id,
          cfId,
          error,
        })
        return c.json(BRES)
      }

      throw simpleError('error_fetching_organization', 'Error fetching organization', { error })
    }

    cloudlog({ requestId: c.get('requestId'), message: 'App missing, skipping onboarding and default versions', record })
    return c.json(BRES)
  }

  // Check if this is a demo app - skip onboarding emails and store info for demo apps
  const isDemo = record.need_onboarding === true
  const isPendingOnboarding = record.need_onboarding === true
  if (isDemo) {
    cloudlog({ requestId: c.get('requestId'), message: 'Demo app detected, skipping onboarding emails and store info' })
  }
  else if (isPendingOnboarding) {
    cloudlog({ requestId: c.get('requestId'), message: 'Pending onboarding app detected, skipping onboarding emails and store info until CLI completes', app_id: record.app_id })
  }

  // Can't proceed with onboarding/default versions without an org id.
  if (!ownerOrg) {
    cloudlog({ requestId: c.get('requestId'), message: 'App missing or no owner_org, skipping onboarding and default versions', record })
    return c.json(BRES)
  }

  let appCreatedBentoEvent: BentoTrackingPayload | undefined
  if (!isDemo && !isPendingOnboarding) {
    appCreatedBentoEvent = await supabase
      .from('orgs')
      .select('*')
      .eq('id', ownerOrg)
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          throw simpleError('error_fetching_organization', 'Error fetching organization', { error })
        }

        const onboardingIntent = parseOrgOnboardingIntent(data.onboarding)
        return {
          cron: '* * * * *',
          event: 'app:created',
          preferenceKey: 'onboarding' as const,
          uniqId: `app:created:${record.app_id}`,
          data: {
            ...buildOnboardingIntentBentoEventData(c, onboardingIntent, {
              id: ownerOrg,
              name: data.name,
              website: data.website,
            }),
            app_name: record.name,
          },
        }
      })
  }

  await sendEventToTracking(c, {
    bento: appCreatedBentoEvent,
    channel: 'app-created',
    event: isDemo ? 'Demo App Created' : isPendingOnboarding ? 'Onboarding App Created' : 'App Created',
    icon: isDemo ? '🎮' : isPendingOnboarding ? '🧭' : '🎉',
    sentToBento: Boolean(appCreatedBentoEvent),
    user_id: ownerOrg,
    groups: { organization: ownerOrg },
    tags: {
      app_id: record.app_id,
      is_demo: isDemo ? 'true' : 'false',
      need_onboarding: isPendingOnboarding ? 'true' : 'false',
    },
    notify: false,
  })

  // Purge on-prem cache for this app to clear any stale responses
  await backgroundTask(c, purgeOnPremCache(c, record.app_id))
  // Skip onboarding emails for demo apps
  if (!isDemo && !isPendingOnboarding) {
    await backgroundTask(c, createIfNotExistStoreInfo(c, {
      app_id: record.app_id,
      updates: 1,
      onprem: true,
      capacitor: true,
      capgo: true,
    }))
  }

  return c.json(BRES)
})
