import type { Context } from 'hono'
import {
  mergeSignupAttribution,
  parseSignupAttributionRecord,
  signupAttributionEventTags,
  type ResolvedSignupAttribution,
  type SignupAttributionEventTags,
} from '../../shared/signup-attribution.ts'
import { cloudlog } from './logging.ts'
import { gotrueAdmin } from './gotrue_admin.ts'

export function signupPluginTagsFromAttribution(attribution: ResolvedSignupAttribution): SignupAttributionEventTags {
  return signupAttributionEventTags(attribution)
}

export async function resolveSignupAttributionForUser(
  c: Context,
  userId: string,
): Promise<ResolvedSignupAttribution> {
  try {
    const { data, error } = await gotrueAdmin(c).getUserById(userId)
    if (error || !data.user)
      return {}
    return parseSignupAttributionRecord(data.user.user_metadata as Record<string, unknown>)
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'signup attribution user lookup failed',
      userId,
      error,
    })
    return {}
  }
}

export async function resolveSignupAttributionForOrg(
  c: Context,
  org: { created_by: string, signup_plugin?: string | null },
): Promise<ResolvedSignupAttribution> {
  const orgSignupPlugin = parseSignupAttributionRecord({
    signup_plugin: org.signup_plugin,
  }).signup_plugin
  const orgOverlay = orgSignupPlugin ? { signup_plugin: orgSignupPlugin } : null

  let attribution: ResolvedSignupAttribution = {}
  try {
    attribution = await resolveSignupAttributionForUser(c, org.created_by)
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'resolveSignupAttributionForOrg creator lookup failed',
      orgId: (org as { id?: string }).id,
      userId: org.created_by,
      error,
    })
  }

  return mergeSignupAttribution(orgOverlay, attribution)
}

export async function signupAttributionTagsForOrg(
  c: Context,
  org: { created_by: string, signup_plugin?: string | null },
): Promise<SignupAttributionEventTags> {
  return signupAttributionEventTags(await resolveSignupAttributionForOrg(c, org))
}
