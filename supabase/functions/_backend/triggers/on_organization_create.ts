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
  const queuedRecord = c.get('webhookBody') as Database['public']['Tables']['orgs']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record: queuedRecord })

  if (!queuedRecord.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id', { record: queuedRecord })
  }

  // INSERT queue payloads omit customer_id when org-create assigns it in a later
  // AFTER INSERT trigger; reload the committed row before Stripe bootstrap.
  const { data: orgRow, error: orgLoadError } = await supabaseAdmin(c)
    .from('orgs')
    .select('*')
    .eq('id', queuedRecord.id)
    .single()

  if (orgLoadError || !orgRow) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'org create reload failed, using queue payload',
      orgId: queuedRecord.id,
      error: orgLoadError?.message,
    })
  }

  const org = orgRow ?? queuedRecord

  let trialPlanName: string | null | undefined
  if (!org.customer_id) {
    trialPlanName = await createStripeCustomer(c, org)
  }
  else if (org.customer_id.startsWith('pending_')) {
    trialPlanName = await finalizePendingStripeCustomer(c, org)
  }

  if (trialPlanName) {
    const { data: creator, error: creatorError } = await supabaseAdmin(c)
      .from('users')
      .select('email')
      .eq('id', org.created_by)
      .maybeSingle()
    if (creatorError)
      cloudlog({ requestId: c.get('requestId'), message: 'trial plan Bento creator lookup failed', userId: org.created_by, error: creatorError })
    if (creator?.email) {
      await backgroundTask(c, syncBentoSubscriberTags(c, {
        email: creator.email.trim().toLowerCase(),
        ...buildBillingPlanBentoTags(trialPlanName, 'trial'),
      }))
    }
  }

  await backgroundTask(c, groupIdentifyPosthog(c, {
    groupType: 'organization',
    groupKey: org.id,
    properties: {
      name: org.name,
      management_email: org.management_email,
      customer_id: org.customer_id,
      created_by: org.created_by,
      created_at: org.created_at,
      website: org.website,
    },
  }))

  const onboardingIntent = parseOrgOnboardingIntent(org.onboarding)
  const onboardingBentoData = buildOnboardingIntentBentoEventData(c, onboardingIntent, {
    id: org.id,
    name: org.name,
    website: org.website,
  })

  await syncOrgOnboardingIntentForOrg(c, org)

  await sendEventToTracking(c, {
    bento: {
      cron: '* * * * *',
      data: onboardingBentoData,
      event: 'org:created',
      preferenceKey: 'onboarding',
      uniqId: `org:created:${org.id}`,
    },
    channel: 'org-created',
    event: 'Org Created',
    sentToBento: true,
    user_id: org.id,
    groups: { organization: org.id },
  })

  return c.json(BRES)
})
