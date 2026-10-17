import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { parseSignupAttributionRecord, signupAttributionEventTags } from '../../shared/signup-attribution.ts'
import { syncBentoSubscriberTags } from '../utils/bento.ts'
import { shouldUseLifecycleV2 } from '../utils/lifecycle_v2_rollout.ts'
import { buildBillingPlanBentoTags } from '../utils/billing_bento_tags.ts'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { buildOnboardingIntentBentoEventData, parseOrgOnboardingIntent, syncOrgOnboardingIntentForOrg } from '../utils/org_onboarding_intent.ts'
import { groupIdentifyPosthog } from '../utils/posthog.ts'
import { resolveSignupAttributionForOrg, resolveSignupAttributionForUser } from '../utils/signup_attribution.ts'
import { createStripeCustomer, finalizePendingStripeCustomer, isPendingStripeCustomerId } from '../utils/stripe_org.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { backgroundTask } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

/** Processes committed org creation with stable analytics identity and notification claims. */
app.post('/', middlewareAPISecret, triggerValidator('orgs', 'INSERT'), async (c) => {
  const queuedRecord = c.get('webhookBody') as Database['public']['Tables']['orgs']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record: queuedRecord })

  if (!queuedRecord.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id', { record: queuedRecord })
  }

  if (!queuedRecord.created_at || !Number.isFinite(new Date(queuedRecord.created_at).getTime()))
    throw simpleError('invalid_payload', 'Missing organization creation timestamp')

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

  let signupPlugin = parseSignupAttributionRecord({
    signup_plugin: org.signup_plugin,
  }).signup_plugin ?? null
  if (!signupPlugin) {
    try {
      const creatorAttribution = await resolveSignupAttributionForUser(c, org.created_by)
      signupPlugin = creatorAttribution.signup_plugin ?? null
      if (signupPlugin) {
        const { error: signupPluginUpdateError } = await supabaseAdmin(c)
          .from('orgs')
          .update({ signup_plugin: signupPlugin })
          .eq('id', org.id)
        if (signupPluginUpdateError) {
          cloudlog({
            requestId: c.get('requestId'),
            message: 'org signup_plugin persist failed',
            orgId: org.id,
            error: signupPluginUpdateError.message,
          })
        }
      }
    }
    catch (error) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'creator signup attribution lookup failed',
        orgId: org.id,
        userId: org.created_by,
        error,
      })
    }
  }

  let trialPlanName: string | null | undefined
  if (!org.customer_id) {
    trialPlanName = await createStripeCustomer(c, org)
  }
  else if (isPendingStripeCustomerId(org.customer_id)) {
    trialPlanName = await finalizePendingStripeCustomer(c, org)
  }

  if (trialPlanName && !await shouldUseLifecycleV2(c, org.id)) {
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

  await backgroundTask(c, syncOrgOnboardingIntentForOrg(c, org).catch((error) => {
    cloudlogErr({ requestId: c.get('requestId'), message: 'syncOrgOnboardingIntentForOrg failed', error })
  }))

  const orgForAttribution = signupPlugin ? { ...org, signup_plugin: signupPlugin } : org
  let orgCreatedAttributionTags: ReturnType<typeof signupAttributionEventTags> = {}
  try {
    orgCreatedAttributionTags = signupAttributionEventTags(
      await resolveSignupAttributionForOrg(c, orgForAttribution),
    )
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'org created attribution tags lookup failed',
      orgId: org.id,
      error,
    })
  }

  await sendEventToTracking(c, {
    bento: {
      once: true,
      data: onboardingBentoData,
      event: 'org:created',
      preferenceKey: 'onboarding',
      uniqId: `org:created:${org.id}`,
    },
    channel: 'org-created',
    event: 'Org Created',
    // pgmq.send is part of the org INSERT transaction; delivery starts after commit.
    occurred_at: new Date(queuedRecord.created_at).toISOString(),
    timeoutMs: 1000,
    sentToBento: true,
    user_id: queuedRecord.created_by,
    groups: { organization: org.id },
    nonPersonTags: {
      org_id: org.id,
      $insert_id: `org-created:${org.id}`,
      capture_source: 'database_trigger',
    },
    tags: {
      owner_org: org.id,
      ...orgCreatedAttributionTags,
    },
  }, { background: false, strict: true, requirePosthogDelivery: true })

  return c.json(BRES)
})
