import type { Context } from 'hono'
import { cloudlogErr, serializeError } from './logging.ts'

/**
 * Paid-ads signups ("pay first") carry `offer = 'direct'` in their auth app
 * metadata (raw_app_meta_data). Only the server writes it, at signup
 * (/auth/register), so users cannot remove it to get a
 * trial. Their orgs get no free trial: trial_at is set to the creation time.
 * Only this exact value has any effect. Keep in sync with
 * public.generate_org_user_stripe_info_on_org_create().
 */
export const DIRECT_OFFER = 'direct'
export const DEFAULT_TRIAL_DAYS = 15
/** Bento tag for direct-offer users. They never get trial tags. */
export const DIRECT_OFFER_BENTO_TAG = 'offer=direct'

/**
 * Minimal admin client shape used for lookups. Callers pass supabaseAdmin(c);
 * taking it as a parameter keeps this module free of an import cycle with
 * supabase.ts.
 */
interface DirectOfferAdminClient {
  auth: { admin: { getUserById: (id: string) => PromiseLike<{ data: { user: { app_metadata?: Record<string, unknown> } | null }, error: unknown }> } }
}

/** `null` means the lookup failed and the offer is unknown. */
export type DirectOfferStatus = boolean | null

export function isDirectOfferMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.offer === DIRECT_OFFER
}

/**
 * Record the direct offer in server-controlled app metadata. Called at signup,
 * before the profile insert that creates the first org, so the org trigger
 * sees it. GoTrue merges app_metadata keys, so provider data is kept.
 */
export async function persistDirectOffer(
  admin: { auth: { admin: { updateUserById: (id: string, attributes: { app_metadata: Record<string, unknown> }) => PromiseLike<{ error: unknown }> } } },
  userId: string,
): Promise<void> {
  const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: { offer: DIRECT_OFFER } })
  if (error)
    throw error
}

export function computeNewOrgTrialEnd(isDirectOffer: boolean, now = new Date()): Date {
  const trialAt = new Date(now)
  if (!isDirectOffer)
    trialAt.setDate(trialAt.getDate() + DEFAULT_TRIAL_DAYS)
  return trialAt
}

/**
 * Whether `userId` signed up through the direct offer, read from server-only
 * app metadata. A failed lookup is logged and rethrown when `throwOnError` is
 * set (entitlement callers, so a transient failure never persists a trial the
 * user should not get); otherwise it resolves to `null` (unknown) so Bento
 * callers can skip trial tagging instead of guessing.
 */
export async function getDirectOfferStatus(
  c: Context,
  admin: DirectOfferAdminClient,
  userId: string | null | undefined,
  options: { throwOnError?: boolean } = {},
): Promise<DirectOfferStatus> {
  if (!userId)
    return false
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId)
    if (error)
      throw error
    return isDirectOfferMetadata(data.user?.app_metadata)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: options.throwOnError ? 'direct offer lookup failed' : 'direct offer lookup failed, offer unknown', userId, error: serializeError(error) })
    if (options.throwOnError)
      throw error
    return null
  }
}

/** Whether `userId` signed up through the direct offer. Lookup failures throw. */
export async function isDirectOfferUser(c: Context, admin: DirectOfferAdminClient, userId: string | null | undefined): Promise<boolean> {
  return await getDirectOfferStatus(c, admin, userId, { throwOnError: true }) === true
}

/**
 * Trial end for a new org created by `creatorId`. Without a creator the
 * standard trial applies; a failed lookup is rethrown so callers fail (and
 * retry) instead of persisting a 15-day trial for a direct-offer user.
 */
export async function resolveNewOrgTrialEnd(c: Context, admin: DirectOfferAdminClient, creatorId: string | null | undefined): Promise<Date> {
  return computeNewOrgTrialEnd(await isDirectOfferUser(c, admin, creatorId))
}
