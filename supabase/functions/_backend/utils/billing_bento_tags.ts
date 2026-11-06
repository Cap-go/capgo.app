import { DIRECT_OFFER_BENTO_TAG } from './direct_offer.ts'

// Trial org that saved a card: its onboarding plan starts when the trial ends.
export const TRIAL_CARD_BENTO_TAG = 'trial-card-on-file'

export type BillingPlanBentoState = 'none' | 'paying' | 'trial'

export function buildBillingPlanBentoTags(
  planName: string | null | undefined,
  state: BillingPlanBentoState,
  trialPlanNamesToRemove?: readonly string[] | null,
): { segments: string[], deleteSegments: string[] } {
  if (state === 'none')
    return { segments: [], deleteSegments: [] }

  if (state === 'trial') {
    return {
      segments: planName ? [`trial-plan:${planName}`] : [],
      deleteSegments: [],
    }
  }
  let trialPlanNames: readonly string[] = []
  if (trialPlanNamesToRemove?.length)
    trialPlanNames = trialPlanNamesToRemove
  else if (planName)
    trialPlanNames = [planName]
  return {
    segments: planName ? [`plan:${planName}`] : [],
    deleteSegments: [...new Set(trialPlanNames.map(name => `trial-plan:${name}`)), TRIAL_CARD_BENTO_TAG],
  }
}

const TRIAL_SEGMENTS = ['trial', 'trial7', 'trial1', 'trial0'] as const
const TRIAL_SEGMENT_SET = new Set<string>(TRIAL_SEGMENTS)

function isTrialSegment(tag: string) {
  return TRIAL_SEGMENT_SET.has(tag) || tag.startsWith('trial-plan:') || tag === TRIAL_CARD_BENTO_TAG
}

/**
 * Tags that make a direct-offer subscriber look like a trial user. Removing
 * them on every direct-offer sync also clears legacy tags left on a reused
 * Bento subscriber (for example an email that signed up before).
 */
export function directOfferTrialTagsToRemove(trialPlanNames: readonly string[] | null | undefined = []): string[] {
  return [...TRIAL_SEGMENTS, TRIAL_CARD_BENTO_TAG, ...(trialPlanNames ?? []).map(name => `trial-plan:${name}`)]
}

/**
 * Direct-offer (paid ads) users never had a trial: tag them `offer=direct`,
 * never add trial tags, and remove any trial tags they still carry, so trial
 * email sequences do not fire for them. Standard users (`false`) are returned
 * unchanged. When the offer is unknown (`null`, lookup failed) trial tags are
 * not added, and nothing else changes until a later sync knows the offer.
 */
export function applyDirectOfferBentoTags(
  tags: { segments: string[], deleteSegments: string[] },
  isDirectOffer: boolean | null,
  trialPlanNames?: readonly string[] | null,
): { segments: string[], deleteSegments: string[] } {
  if (isDirectOffer === false)
    return tags
  const removedTrialSegments = tags.segments.filter(isTrialSegment)
  const segments = tags.segments.filter(tag => !isTrialSegment(tag))
  if (isDirectOffer === null)
    return { segments, deleteSegments: tags.deleteSegments }
  return {
    segments: [...segments, DIRECT_OFFER_BENTO_TAG],
    deleteSegments: Array.from(new Set([...tags.deleteSegments, ...removedTrialSegments, ...directOfferTrialTagsToRemove(trialPlanNames)])).filter(tag => tag !== DIRECT_OFFER_BENTO_TAG),
  }
}
