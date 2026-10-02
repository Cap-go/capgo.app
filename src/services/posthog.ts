// @ts-nocheck
import { shouldSuppressPostHogExceptionEvent } from '~/services/staleAssetErrors'
import { isLocal } from '~/services/console'

const POSTHOG_URL_PROPERTY_KEYS = [
  '$current_url',
  '$initial_current_url',
  '$initial_referrer',
  '$referrer',
  'current_url',
  'url',
]

function isInvitationTokenKey(value: string): boolean {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' ')).toLowerCase().includes('invite_magic_string')
  }
  catch {
    return value.toLowerCase().includes('invite_magic_string')
  }
}

function removeInvitationToken(value: unknown): unknown {
  if (typeof value !== 'string')
    return value

  try {
    const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    const url = new URL(value, 'https://redacted.invalid')
    let removedToken = false
    for (const key of [...url.searchParams.keys()]) {
      if (isInvitationTokenKey(key)) {
        url.searchParams.delete(key)
        removedToken = true
      }
    }
    if (!removedToken)
      return value
    return isAbsolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  }
  catch {
    let removedToken = false
    const sanitized = value.replace(/([?&])([^=&#]+)(?:=[^&#]*)?/g, (match, separator, key) => {
      if (!isInvitationTokenKey(key))
        return match
      removedToken = true
      return `${separator}${key}=[redacted]`
    })
    return removedToken ? sanitized : value
  }
}

function sanitizeInvitationUrlProperties(properties: Record<string, unknown>) {
  const sanitized = { ...properties }
  for (const key of POSTHOG_URL_PROPERTY_KEYS) {
    if (key in sanitized)
      sanitized[key] = removeInvitationToken(sanitized[key])
  }
  return sanitized
}

export function sanitizePostHogInvitationEvent(event: unknown) {
  if (!event || typeof event !== 'object')
    return event

  const properties = (event as { properties?: Record<string, unknown> }).properties
  if (!properties)
    return event

  const sanitizedProperties = sanitizeInvitationUrlProperties(properties)
  for (const key of ['$set', '$set_once']) {
    const nestedProperties = sanitizedProperties[key]
    if (nestedProperties && typeof nestedProperties === 'object' && !Array.isArray(nestedProperties))
      sanitizedProperties[key] = sanitizeInvitationUrlProperties(nestedProperties as Record<string, unknown>)
  }

  return { ...event, properties: sanitizedProperties }
}

export function posthogLoader(supaHost: string) {
  if (isLocal(supaHost))
    return
  !function (t, e) { var o, n, p, r; e.__SV || (window.posthog && window.posthog.__loaded) || (window.posthog = e, e._i = [], e.init = function (i, s, a) { function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } } (p = t.createElement("script")).type = "text/javascript", p.crossOrigin = "anonymous", p.async = !0, p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js", (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r); var u = e; for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], u.toString = function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e }, u.people.toString = function () { return u.toString(1) + ".people (stub)" }, o = "ki Ci init qi Hi pr Bi zi Di capture calculateEventProperties Qi register register_once register_for_session unregister unregister_for_session Ki getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync Xi identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset shutdown setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty Ji Gi createPersonProfile setInternalOrTestUser Yi Ai rn opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing Vi debug mr it getPageViewId captureTraceFeedback captureTraceMetric Oi".split(" "), n = 0; n < o.length; n++)g(u, o[n]); e._i.push([i, s, a]) }, e.__SV = 1) }(document, window.posthog || []);
  posthog.init('phc_NXDyDajQaTQVwb25DEhIVZfxVUn4R0Y348Z7vWYHZUi', {
    api_host: 'https://psthg.capgo.app',
    ui_host: 'https://eu.posthog.com',
    person_profiles: 'identified_only',
    defaults: '2026-05-30',
    before_send: (event) => {
      const sanitizedEvent = sanitizePostHogInvitationEvent(event)
      if (shouldSuppressPostHogExceptionEvent(sanitizedEvent))
        return false
      return sanitizedEvent
    },
  })
}

type JsonPrimitive = string | number | boolean | null
type PostHogProperties = Record<string, JsonPrimitive>

export function pushEvent(nameEvent: string, supaHost: string, properties?: PostHogProperties): void {
  if (isLocal(supaHost))
    return
  posthog.capture(nameEvent, properties)
}

export function pushEventForUser(nameEvent: string, uuid: string, supaHost: string, properties?: PostHogProperties): void {
  if (isLocal(supaHost))
    return
  posthog.identify(uuid)
  posthog.capture(nameEvent, properties)
}

export function setUser(uuid: string, data: {
  nickname?: string
  phone?: string
  email?: string
  avatar?: string
}, supaHost: string): void {
  if (isLocal(supaHost))
    return
  // console.log('setUser')
  posthog.identify(
    uuid,
    { email: data.email, name: data.nickname },
  )
  posthog.setPersonProperties(
    { avatar: data.avatar },
  )
}

export function reset(supaHost: string): void {
  if (isLocal(supaHost))
    return
  posthog.reset()
}
