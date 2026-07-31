import type { TrackOptions } from '@logsnag/node'
import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { BentoTrackingPayload } from '../utils/tracking.ts'
import { Hono } from 'hono/tiny'
import { BUILDER_RECOVERY_MILESTONES, buildBuilderOnboardingBentoEvent } from '../utils/builder_onboarding_recovery.ts'
import { BUNDLE_INCOMPATIBLE_EVENT, buildBundleCompatibilityBentoEvent } from '../utils/bundle_compatibility_recovery.ts'
import { BRES, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { trackPosthogEvent } from '../utils/posthog.ts'
import { checkPermission } from '../utils/rbac.ts'
import { broadcastCLIEvent } from '../utils/realtime_broadcast.ts'
import { supabaseWithAuth } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { backgroundTask } from '../utils/utils.ts'

// PostHog event recording whether the org-member incompatibility email was sent
// or skipped (and why). Powers the weekly sent-vs-skipped breakdown.
const BUNDLE_INCOMPATIBLE_EMAIL_EVENT = 'Bundle Incompatible Email'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

interface ResolvedTrackingId {
  trackingUserId: string
  // Only set when we've verified the id refers to an organization the caller
  // can access. Events for a bare authenticated user (no requestedUserId, or
  // requestedUserId === authUserId) leave this undefined so we don't pollute
  // the PostHog `organization` group with user UUIDs.
  orgId?: string
}

interface TrackEventBody extends TrackOptions {
  notifyConsole?: boolean
  org_id?: string
  tracking_version?: number | string
  nonPersonTags?: Record<string, string | number | boolean>
}

function isTrackingV2(version: unknown) {
  return version === 2 || version === '2'
}

// Coerce a tag/DB value (string id, numeric/bigint id, or missing) into a
// non-empty string id or undefined — keeps the Bento payload *_id fields clean.
function toIdString(value: unknown): string | undefined {
  if (typeof value === 'string')
    return value.length > 0 ? value : undefined
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value)
  return undefined
}

async function resolveTrackingUserId(
  c: Context<MiddlewareKeyVariables>,
  requestedUserId: string | undefined,
  requestedOrgId: string | undefined,
  appId: string | undefined,
  trackingV2 = false,
  notifyConsole = false,
): Promise<ResolvedTrackingId> {
  const forbiddenError = notifyConsole ? 'Forbidden' : 'no_permission'
  const authUserId = c.get('auth')?.userId ?? ''

  if (trackingV2) {
    if (!requestedOrgId) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'tracking v2 event missing org_id; sending actor-scoped event without organization group',
      })
      return { trackingUserId: authUserId }
    }

    if (appId) {
      if (!(await checkPermission(c, 'app.read', { appId }))) {
        throw quickError(403, forbiddenError, 'You cannot send events for this organization')
      }

      const supabase = supabaseWithAuth(c, c.get('auth')!)
      const { data: app, error } = await supabase
        .from('apps')
        .select('owner_org')
        .eq('app_id', appId)
        .single()

      if (error || !app || app.owner_org !== requestedOrgId) {
        throw quickError(403, forbiddenError, 'You cannot send events for this organization')
      }

      return { trackingUserId: authUserId, orgId: requestedOrgId }
    }

    if (await checkPermission(c, 'org.read', { orgId: requestedOrgId })) {
      return { trackingUserId: authUserId, orgId: requestedOrgId }
    }

    throw quickError(403, forbiddenError, 'You cannot send events for this organization')
  }

  if (!requestedUserId || requestedUserId === authUserId) {
    return { trackingUserId: authUserId }
  }

  if (appId) {
    if (!(await checkPermission(c, 'app.read', { appId }))) {
      throw quickError(403, forbiddenError, 'You cannot send events for this organization')
    }

    const supabase = supabaseWithAuth(c, c.get('auth')!)
    const { data: app, error } = await supabase
      .from('apps')
      .select('owner_org')
      .eq('app_id', appId)
      .single()

    if (error || !app || app.owner_org !== requestedUserId) {
      throw quickError(403, forbiddenError, 'You cannot send events for this organization')
    }

    return { trackingUserId: requestedUserId, orgId: requestedUserId }
  }

  if (await checkPermission(c, 'org.read', { orgId: requestedUserId })) {
    return { trackingUserId: requestedUserId, orgId: requestedUserId }
  }

  throw quickError(403, forbiddenError, 'You cannot send events for this organization')
}

function getRequestedOrgId(body: TrackEventBody, trackingV2: boolean) {
  if (trackingV2 && typeof body.org_id === 'string' && body.org_id.length > 0)
    return body.org_id
  if (body.notifyConsole && typeof body.user_id === 'string' && body.user_id.length > 0)
    return body.user_id
  return undefined
}

function getAppId(body: TrackEventBody) {
  if (typeof body.tags?.['app-id'] === 'string')
    return body.tags['app-id']
  if (typeof body.tags?.app_id === 'string')
    return body.tags.app_id
  return undefined
}

function buildTrackedBody(
  trackingV2: boolean,
  verifiedOrgId: string | undefined,
  requestedUserId: string | undefined,
  trackingUserId: string,
  trackOptions: Omit<TrackEventBody, 'notifyConsole' | 'org_id' | 'tracking_version'>,
) {
  const trackedTags = trackingV2 && verifiedOrgId
    ? { ...(trackOptions.tags || {}), org_id: verifiedOrgId }
    : trackOptions.tags
  if (trackingV2)
    return { ...trackOptions, user_id: trackingUserId, tags: trackedTags }
  if (requestedUserId)
    return { ...trackOptions, user_id: trackingUserId }
  return trackOptions
}

async function handleNotifyConsole(
  c: Context<MiddlewareKeyVariables>,
  trackedBody: TrackOptions,
  appId: string | undefined,
  verifiedOrgId: string | undefined,
) {
  if (!verifiedOrgId)
    throw simpleError('missing_org_id', 'Missing org ID for console notification')

  await backgroundTask(c, broadcastCLIEvent(c, {
    event: trackedBody.event,
    channel: trackedBody.channel,
    description: trackedBody.description,
    icon: trackedBody.icon,
    app_id: appId,
    org_id: verifiedOrgId,
    channel_name: typeof trackedBody.tags?.channel === 'string' ? trackedBody.tags.channel : undefined,
    bundle_name: typeof trackedBody.tags?.bundle === 'string' ? trackedBody.tags.bundle : undefined,
    timestamp: new Date().toISOString(),
  }))
}

async function buildOnboardingBentoEvent(
  c: Context<MiddlewareKeyVariables>,
  supabase: ReturnType<typeof supabaseWithAuth>,
  onboardingOrgId: string | undefined,
  appId: string | undefined,
  trackedBody: TrackOptions,
) {
  if (!onboardingOrgId || !appId || trackedBody.event !== 'onboarding-step-done')
    return undefined

  return Promise.all([
    supabase
      .from('orgs')
      .select('*')
      .eq('id', onboardingOrgId)
      .single(),
    supabase
      .from('apps')
      .select('*')
      .eq('app_id', appId)
      .single(),
  ]).then(([orgResult, appResult]) => {
    if (orgResult.error || !orgResult.data || appResult.error || !appResult.data) {
      throw simpleError('error_fetching_organization_or_app', 'Error fetching organization or app', { org: orgResult.error, app: appResult.error })
    }

    return {
      cron: '* * * * *',
      event: 'app:updated',
      preferenceKey: 'onboarding' as const,
      uniqId: `app:updated:${appId}`,
      data: {
        org_id: orgResult.data.id,
        org_name: orgResult.data.name,
        app_name: appResult.data.name,
      },
    }
  })
}

async function buildBuilderBentoEvent(
  c: Context<MiddlewareKeyVariables>,
  supabase: ReturnType<typeof supabaseWithAuth>,
  body: TrackEventBody,
  onboardingOrgId: string | undefined,
  appId: string | undefined,
  trackedBody: TrackOptions,
) {
  const builderStep = typeof body.tags?.step === 'string' ? body.tags.step : undefined
  const builderPlatform = typeof body.tags?.platform === 'string' ? body.tags.platform : undefined
  if (
    !onboardingOrgId || !appId
    || trackedBody.event !== 'Builder Onboarding Step'
    || !builderStep || !BUILDER_RECOVERY_MILESTONES.has(builderStep)
  )
    return undefined

  const [orgResult, appResult] = await Promise.all([
    supabase.from('orgs').select('id, name').eq('id', onboardingOrgId).single(),
    supabase.from('apps').select('name').eq('app_id', appId).single(),
  ])
  if (orgResult.error || appResult.error) {
    // Best-effort recovery signal: never fail the wizard's request, and don't
    // emit a Bento event with empty org/app names. Log and skip instead.
    cloudlog({ requestId: c.get('requestId'), message: 'builder onboarding bento lookup failed; skipping signal', org: orgResult.error, app: appResult.error })
    return undefined
  }

  return buildBuilderOnboardingBentoEvent({
    event: trackedBody.event,
    step: builderStep,
    orgId: onboardingOrgId,
    appId,
    platform: builderPlatform,
    orgName: orgResult.data?.name ?? undefined,
    appName: appResult.data?.name ?? undefined,
  })
}

async function buildBundleIncompatibleBentoEvent(
  c: Context<MiddlewareKeyVariables>,
  supabase: ReturnType<typeof supabaseWithAuth>,
  onboardingOrgId: string | undefined,
  appId: string | undefined,
  trackedBody: TrackOptions,
) {
  const channelOverwritten = trackedBody.tags?.channel_overwritten === true
    || trackedBody.tags?.channel_overwritten === 'true'
  if (!onboardingOrgId || !appId || trackedBody.event !== BUNDLE_INCOMPATIBLE_EVENT || !channelOverwritten)
    return undefined

  const tags = trackedBody.tags ?? {}
  const incompatibleChannel = typeof tags.channel === 'string' ? tags.channel : undefined

  let updateStrategy: string | null = null
  if (incompatibleChannel) {
    const { data: channelRow } = await supabase
      .from('channels')
      .select('disable_auto_update')
      .eq('app_id', appId)
      .eq('name', incompatibleChannel)
      .maybeSingle()
    updateStrategy = channelRow?.disable_auto_update ?? null
  }
  const skippedForMetadata = updateStrategy === 'version_number'

  await backgroundTask(c, trackPosthogEvent(c, {
    event: BUNDLE_INCOMPATIBLE_EMAIL_EVENT,
    user_id: typeof trackedBody.user_id === 'string' ? trackedBody.user_id : undefined,
    channel: 'bundle',
    setPersonProperties: false,
    groups: { organization: onboardingOrgId },
    tags: {
      outcome: skippedForMetadata ? 'skipped_metadata' : 'sent',
      update_strategy: updateStrategy ?? 'unknown',
      app_id: appId,
      ...(incompatibleChannel ? { channel_name: incompatibleChannel } : {}),
    },
  }))

  if (skippedForMetadata)
    return undefined

  const versionNewName = typeof tags.version_new_name === 'string' && tags.version_new_name.length > 0
    ? tags.version_new_name
    : undefined
  const [orgResult, appResult] = await Promise.all([
    supabase.from('orgs').select('id, name').eq('id', onboardingOrgId).single(),
    supabase.from('apps').select('name').eq('app_id', appId).single(),
  ])
  if (orgResult.error || appResult.error) {
    // Best-effort signal: never fail the CLI's request, and don't emit a Bento
    // event with empty org/app context. Log and skip instead.
    cloudlog({ requestId: c.get('requestId'), message: 'bundle incompatible bento lookup failed; skipping signal', org: orgResult.error, app: appResult.error })
    return undefined
  }

  let versionNewId: string | undefined
  if (versionNewName) {
    const { data: versionNewData } = await supabase
      .from('app_versions')
      .select('id')
      .eq('app_id', appId)
      .eq('name', versionNewName)
      .maybeSingle()
    versionNewId = toIdString(versionNewData?.id)
  }

  return buildBundleCompatibilityBentoEvent({
    event: trackedBody.event,
    orgId: onboardingOrgId,
    appId,
    channelOverwritten,
    channel: incompatibleChannel,
    source: typeof tags.source === 'string' ? tags.source : undefined,
    versionNewId,
    versionNewName,
    versionOldId: toIdString(tags.version_old_id),
    versionOldName: typeof tags.version_old_name === 'string' ? tags.version_old_name : undefined,
    orgName: orgResult.data?.name ?? undefined,
    appName: appResult.data?.name ?? undefined,
  })
}

app.post('/', middlewareAuth(), async (c) => {
  const body = await parseBody<TrackEventBody>(c)
  const { notifyConsole = false, org_id: _orgId, tracking_version: _trackingVersion, ...trackOptions } = body
  const trackingV2 = isTrackingV2(body.tracking_version)
  const requestedOrgId = getRequestedOrgId(body, trackingV2)
  const requestedUserId = typeof body.user_id === 'string' ? body.user_id : undefined
  const appId = getAppId(body)
  const { trackingUserId, orgId: verifiedOrgId } = await resolveTrackingUserId(c, requestedUserId, requestedOrgId, appId, trackingV2, Boolean(body.notifyConsole))
  const trackedBody = buildTrackedBody(trackingV2, verifiedOrgId, requestedUserId, trackingUserId, trackOptions)

  // notifyConsole: broadcast to Supabase Realtime only, skip all tracking
  if (notifyConsole) {
    await handleNotifyConsole(c, trackedBody, appId, verifiedOrgId)
    return c.json(BRES)
  }

  const supabase = supabaseWithAuth(c, c.get('auth')!)

  // Resolve the org from the verified org id (v2) or the legacy user_id-as-org
  // value (v1 only). Under tracking v2, trackedBody.user_id is the authenticated
  // *user*, so it must never be used to look up the organization — a v2 event
  // without an org_id simply skips the Bento notification.
  const onboardingOrgId = verifiedOrgId
    ?? (!trackingV2 && typeof trackedBody.user_id === 'string' ? trackedBody.user_id : undefined)
  const onboardingBentoEvent: BentoTrackingPayload | undefined = await buildOnboardingBentoEvent(c, supabase, onboardingOrgId, appId, trackedBody)

  // Builder native-build onboarding (capgo build init): emit start/finish signal
  // events to Bento so a later automation can recover users who started but never
  // finished. Mirrors the onboarding-step-done block above. Only the milestone
  // steps trigger the org/app lookup.
  const builderBentoEvent: BentoTrackingPayload | undefined = await buildBuilderBentoEvent(c, supabase, body, onboardingOrgId, appId, trackedBody)

  // Bundle compatibility failure (capgo bundle upload / bundle compatibility):
  // when the CLI reports an incompatible bundle, emit a Bento signal so a
  // lifecycle automation can react. Mirrors the builder block above; resolves
  // org/app names + the freshly created version id for the payload.
  // PostHog records every incompatible upload (tracking runs unconditionally
  // below). The org-member email is only relevant when the incompatible bundle
  // actually went live — i.e. the upload overwrote the channel's version — AND the
  // channel doesn't gate delivery itself. On the metadata (`version_number`)
  // strategy, `min_update_version` keeps the bundle off incompatible devices, so
  // there's no breakage to warn about — we skip the email there. Either outcome is
  // recorded in PostHog (sent vs skipped_metadata) for the weekly breakdown.
  const bundleIncompatibleBentoEvent: BentoTrackingPayload | undefined = await buildBundleIncompatibleBentoEvent(c, supabase, onboardingOrgId, appId, trackedBody)

  // Exactly one of these is ever set (distinct event names); `??` picks the active one.
  const bentoEvent = onboardingBentoEvent ?? builderBentoEvent ?? bundleIncompatibleBentoEvent
  await sendEventToTracking(c, {
    ...trackedBody,
    bento: bentoEvent,
    sentToBento: Boolean(bentoEvent),
    groups: verifiedOrgId ? { organization: verifiedOrgId } : undefined,
  })

  return c.json(BRES)
})
