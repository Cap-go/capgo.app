import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { syncBentoSubscriberTags } from '../utils/bento.ts'
import { buildBillingPlanBentoTags } from '../utils/billing_bento_tags.ts'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { groupIdentifyPosthog } from '../utils/posthog.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { createStripeCustomer, finalizePendingStripeCustomer } from '../utils/stripe_org.ts'
import { buildOnboardingIntentBentoEventData, parseOrgOnboardingIntent, syncOrgOnboardingIntentForOrg } from '../utils/org_onboarding_intent.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { backgroundTask } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('orgs', 'INSERT'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['orgs']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id', { record })
  }

  let trialPlanName: string | null | undefined
  if (!record.customer_id) {
    trialPlanName = await createStripeCustomer(c, record)
  }
  else if (record.customer_id.startsWith('pending_')) {
    trialPlanName = await finalizePendingStripeCustomer(c, record)
  }

  if (trialPlanName) {
    const { data: creator, error: creatorError } = await supabaseAdmin(c)
      .from('users')
      .select('email')
      .eq('id', record.created_by)
      .maybeSingle()
    if (creatorError)
      cloudlog({ requestId: c.get('requestId'), message: 'trial plan Bento creator lookup failed', userId: record.created_by, error: creatorError })
    if (creator?.email) {
      await backgroundTask(c, syncBentoSubscriberTags(c, {
        email: creator.email.trim().toLowerCase(),
        ...buildBillingPlanBentoTags(trialPlanName, 'trial'),
      }))
    }
  }

  await backgroundTask(c, groupIdentifyPosthog(c, {
    groupType: 'organization',
    groupKey: record.id,
    properties: {
      name: record.name,
      management_email: record.management_email,
      customer_id: record.customer_id,
      created_by: record.created_by,
      created_at: record.created_at,
      website: record.website,
    },
  }))

  const onboardingIntent = parseOrgOnboardingIntent(record.onboarding)
  const onboardingBentoData = buildOnboardingIntentBentoEventData(c, onboardingIntent, {
    id: record.id,
    name: record.name,
    website: record.website,
  })

  await syncOrgOnboardingIntentForOrg(c, record)

  await sendEventToTracking(c, {
    bento: {
      cron: '* * * * *',
      data: onboardingBentoData,
      event: 'org:created',
      preferenceKey: 'onboarding',
      uniqId: `org:created:${record.id}`,
    },
    channel: 'org-created',
    event: 'Org Created',
    icon: '🎉',
    sentToBento: true,
    user_id: record.id,
    groups: { organization: record.id },
    notify: false,
  })

  return c.json(BRES)
})
