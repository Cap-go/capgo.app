import type { ReadOnlyContext } from '../../contracts.ts'
import type { LifecycleAppRow, Product } from './evidence.ts'
import type { VerifiedSnapshot } from './refresh.ts'
import type { AcceptedPurpose, JourneyState, LifecycleInput, PlanRecommendation } from './types.ts'
import { isLifecycleV2Creator } from '../../../../supabase/functions/_backend/utils/lifecycle_v2_cohort.ts'
import { acceptedLifecycleCommercialOffer } from './commercial.ts'
import { buildAppEvidence } from './evidence.ts'
import { HOUR, ms } from './types.ts'

interface SourceRow extends Record<string, unknown> {
  org_id: string
  product: Product
  org_name: string
  enrolled_at: string | Date
  selected_app_incarnation: string | null
  revision: string | number
  state: Partial<JourneyState>
  support_hold: boolean
  org_onboarding: { intent?: string }
  org_preferences: Record<string, unknown>
  creator_onboarding: { abtests?: Record<string, { branch?: string, assigned_at?: string }>, abtests_enrolled?: string[] }
  creator_created_at: string | Date
  creator_created_via_invite: boolean | null
  recipient_id: string | null
  email: string | null
  recipient_preferences: Record<string, unknown> | null
  enable_notifications: boolean
  opt_for_newsletters: boolean
  authorized: boolean
  app: LifecycleAppRow | null
  any_app: boolean
  captured_at: string | Date | null
  acknowledged_before: string | Date | null
  seen_facts: string[] | null
  verified: VerifiedSnapshot | null
  verified_at: string | Date | null
  healthy: boolean | null
  customer_id: string | null
  trial_at: string | Date | null
  status: string | null
  subscription_id: string | null
  has_usage_credits: boolean
  build_time_exceeded: boolean
  now_at: string | Date
}

export const LIFECYCLE_SOURCE_SQL = `
SELECT j.*, o.name AS org_name, o.onboarding AS org_onboarding, o.email_preferences AS org_preferences,
  original.onboarding AS creator_onboarding, original.created_at AS creator_created_at,
  original.created_via_invite AS creator_created_via_invite,
  recipient.id AS recipient_id, LOWER(recipient.email) AS email, recipient.email_preferences AS recipient_preferences,
  recipient.enable_notifications, recipient.opt_for_newsletters,
  EXISTS (SELECT 1 FROM public.role_bindings rb WHERE rb.principal_type = 'user' AND rb.principal_id = recipient.id
    AND rb.scope_type = 'org' AND rb.org_id = j.org_id AND rb.is_direct
    AND (rb.expires_at IS NULL OR rb.expires_at > CURRENT_TIMESTAMP)) AS authorized,
  EXISTS (SELECT 1 FROM public.apps owned WHERE owned.owner_org = j.org_id LIMIT 1) AS any_app,
  CASE WHEN a.id IS NOT NULL THEN pg_catalog.to_jsonb(a) - 'onboarding' || pg_catalog.jsonb_build_object('onboarding', a.onboarding) END AS app,
  obs.captured_at, obs.acknowledged_before, obs.seen_facts, obs.verified, obs.verified_at, obs.healthy,
  o.customer_id, o.has_usage_credits, si.trial_at, si.status, si.subscription_id, si.build_time_exceeded,
  CURRENT_TIMESTAMP AS now_at
FROM public.bento_lifecycle_journeys j
JOIN public.orgs o ON o.id = j.org_id
JOIN public.org_lifecycle_creators provenance ON provenance.org_id = j.org_id
LEFT JOIN public.users original ON original.id = provenance.original_creator_id
LEFT JOIN public.users recipient ON recipient.id = o.created_by
LEFT JOIN public.apps a ON a.id = j.selected_app_incarnation AND a.owner_org = j.org_id
LEFT JOIN public.bento_lifecycle_app_observations obs
  ON obs.org_id = j.org_id AND obs.product = j.product AND obs.app_incarnation = a.id
LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
WHERE j.org_id = $1::uuid AND j.product = $2
`

export const originalCreatorHasTreatment = isLifecycleV2Creator

export const timestamp = (value: Date | string | null | undefined) => value instanceof Date ? value.toISOString() : value ?? null

function journeyState(row: SourceRow): JourneyState {
  const enrolledAt = timestamp(row.enrolled_at)!
  const state = row.state ?? {}
  return {
    enrolledAt,
    lastProgressAt: typeof state.lastProgressAt === 'string' ? state.lastProgressAt : enrolledAt,
    appLessSince: state.appLessSince ?? null,
    checklistCompleteAt: state.checklistCompleteAt ?? null,
    firstValueAt: state.firstValueAt ?? null,
    batch: state.batch ?? null,
  }
}

export async function readAcceptedPurposes(ctx: ReadOnlyContext, orgId: string): Promise<AcceptedPurpose[]> {
  const rows = await ctx.query<{ purpose: string, accepted_at: string | Date, context: string, product: Product, branch: string, commercial_offer: string | null }>(`
    SELECT tag AS purpose, event_at AS accepted_at, details->'metadata'->>'context' AS context,
      details->'metadata'->>'product' AS product, details->'metadata'->>'branch' AS branch,
      details->'metadata'->>'commercialOffer' AS commercial_offer
    FROM public.bento_event_dispatches WHERE flow_key LIKE 'lifecycle:v2:%'
      AND details->'metadata'->>'orgId' = $1 AND status = 'accepted'
      AND (tag NOT LIKE 'summary:%' OR event_at > CURRENT_TIMESTAMP - INTERVAL '7 days'
        OR details->'metadata'->>'branch' IN ('first_update_success', 'first_real_success', 'resumed_progress_digest', 'checklist_complete_purchase'))
    ORDER BY event_at DESC LIMIT 100`, [orgId])
  return rows.flatMap((row) => {
    const item = { purpose: row.purpose, acceptedAt: timestamp(row.accepted_at)!, context: row.context, product: row.product }
    const aliases: string[] = []
    if (row.branch === 'first_update_success' || row.branch === 'first_real_success')
      aliases.push(`success:${row.product}`)
    if (row.branch === 'resumed_progress_digest')
      aliases.push(`resumed:${row.product}`)
    if (acceptedLifecycleCommercialOffer(row.branch, row.commercial_offer))
      aliases.push(`offer:${row.product}`)
    return [item, ...aliases.map(purpose => ({ ...item, purpose }))]
  })
}

async function readRecommendation(ctx: ReadOnlyContext, orgId: string): Promise<PlanRecommendation | null> {
  const [plan] = await ctx.query<{ name: string, price_m: string | number, mau: string | number, build_time_unit: string | number }>(`
    SELECT p.name, p.price_m, p.mau, p.build_time_unit
    FROM public.orgs o JOIN public.stripe_info si ON si.customer_id = o.customer_id
    JOIN public.org_metrics_cache m ON m.org_id = o.id
      AND m.start_date = si.subscription_anchor_start::date AND m.end_date = si.subscription_anchor_end::date
      AND m.cached_at > CURRENT_TIMESTAMP - INTERVAL '1 day'
    JOIN public.plans p ON p.price_m > 0 AND p.mau >= m.mau AND p.storage >= m.storage
      AND p.bandwidth >= m.bandwidth AND p.build_time_unit >= m.build_time_unit
    WHERE o.id = $1::uuid ORDER BY p.price_m, p.name LIMIT 1`, [orgId])
  if (!plan || !Number.isFinite(Number(plan.price_m)))
    return null
  return { name: plan.name, monthlyPrice: Number(plan.price_m), reason: 'This is the lowest monthly plan that covers your organization’s current measured usage.', includes: `${Number(plan.mau).toLocaleString('en-US')} monthly active users and ${Math.floor(Number(plan.build_time_unit) / 60)} build minutes.` }
}

export function resolveAppEvidence(app: LifecycleAppRow, product: Product, verified: VerifiedSnapshot) {
  const canonical = buildAppEvidence(app, product, verified)
  if (!canonical || product !== 'ota')
    return canonical
  const onboarding = structuredClone(app.onboarding) as { setup?: { steps?: { ota?: Record<string, unknown> } } }
  const steps = onboarding?.setup?.steps?.ota
  if (!steps)
    return canonical
  if (verified.otaDeviceAt && ms(verified.otaDeviceAt) >= ms(app.created_at))
    steps.run_device = { status: 'done', at: verified.otaDeviceAt }
  if (verified.otaBundleAt && verified.otaUploadId && ms(verified.otaBundleAt) >= ms(app.created_at))
    steps.upload_bundle = { status: 'done', at: verified.otaBundleAt }
  const factual = buildAppEvidence({ ...app, onboarding }, product, verified)!
  // Positive independent telemetry informs help, while purchase readiness
  // still requires the canonical persisted checklist itself to be resolved.
  factual.checklistComplete = canonical.checklistComplete
  return factual
}

export async function loadLifecycleInput(ctx: ReadOnlyContext, orgId: string, product: Product) {
  const [row] = await ctx.query<SourceRow>(LIFECYCLE_SOURCE_SQL, [orgId, product])
  if (!row)
    return null
  const now = timestamp(row.now_at)!
  const verifiedFresh = ms(timestamp(row.verified_at)) + HOUR / 6 > ms(now)
  const evidence = row.app ? resolveAppEvidence(row.app, product, verifiedFresh ? row.verified ?? {} : {}) : null
  const state = journeyState(row)
  if (evidence && product === 'builder') {
    evidence.fundingBlocked = ms(row.verified?.fundingDeniedAt) >= ms(evidence.createdAt) && !row.has_usage_credits
      && (row.build_time_exceeded === true || (row.status !== 'succeeded' && ms(timestamp(row.trial_at)) <= ms(now)))
      && (!evidence.firstValue || ms(evidence.firstValue.at) < ms(row.verified?.fundingDeniedAt))
  }
  const selected = row.org_onboarding?.intent === product || row.org_onboarding?.intent === 'both'
  const consent = row.authorized && row.enable_notifications && row.opt_for_newsletters
    && row.org_preferences?.onboarding !== false && row.recipient_preferences?.onboarding !== false
    && (product !== 'builder' || row.recipient_preferences?.builder_onboarding !== false)
    && !!row.recipient_id && !!row.email
  const input: LifecycleInput = {
    now,
    orgId,
    orgName: row.org_name,
    product,
    recipientId: row.recipient_id ?? '',
    email: row.email ?? '',
    creatorTreatment: originalCreatorHasTreatment(row.creator_onboarding, row.creator_created_at, row.creator_created_via_invite),
    consent: !!consent,
    selected,
    shippingIntent: selected,
    supportHold: row.support_hold,
    paused: !consent,
    evidence,
    sourceHealthy: (!row.app && !row.any_app) || (!!row.captured_at && row.healthy === true && verifiedFresh),
    state,
    accepted: await readAcceptedPurposes(ctx, orgId),
    trialDeadline: timestamp(row.trial_at),
    billingHealthy: !!row.customer_id && !!row.trial_at && !!row.status,
    paid: row.status === 'succeeded' && !!row.subscription_id,
    // Conservative suppression: the replicated current allowance flag means
    // coverage may exist, so never pressure an upgrade while it is available.
    compatibleCredits: row.has_usage_credits,
    plan: await readRecommendation(ctx, orgId),
  }
  return { input, revision: Number(row.revision), capturedAt: timestamp(row.captured_at), seenFacts: row.seen_facts ?? [], row }
}
