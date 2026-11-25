/**
 * Paid-ads signups carry `offer = 'direct'` in their auth app metadata.
 * Only this exact value has any effect. Keep in sync with
 * public.generate_org_user_stripe_info_on_org_create().
 */
export const DIRECT_OFFER = 'direct'

/** True when auth app_metadata marks a paid-ads (direct offer) signup. */
export function isDirectOfferMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.offer === DIRECT_OFFER
}
