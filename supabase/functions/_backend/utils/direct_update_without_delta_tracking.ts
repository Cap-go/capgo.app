import type { BentoTrackingPayload } from './tracking.ts'

/**
 * CLI `bundle upload` emits this when CapacitorUpdater instant/direct updates
 * are enabled but the upload is not using delta (`--no-delta`, declined
 * prompt, or delta unavailable). PostHog already records it; this helper
 * builds the Bento payload so org admins can get a lifecycle automation / email.
 */
export const DIRECT_UPDATE_WITHOUT_DELTA_EVENT = 'Direct Update Without Delta'
export const DIRECT_UPDATE_WITHOUT_DELTA_BENTO_EVENT = 'direct_update_without_delta'

export interface DirectUpdateWithoutDeltaBentoInput {
  event: string
  orgId: string | undefined
  appId: string | undefined
  orgName?: string
  appName?: string
  tags?: Record<string, string | number | boolean>
}

/**
 * Pure: emit a Bento signal when a direct-update app is uploaded without
 * delta files. Returns undefined when the event name does not match or
 * org/app context is missing.
 */
export function buildDirectUpdateWithoutDeltaBentoEvent(input: DirectUpdateWithoutDeltaBentoInput): BentoTrackingPayload | undefined {
  if (input.event !== DIRECT_UPDATE_WITHOUT_DELTA_EVENT)
    return undefined
  if (!input.orgId || !input.appId)
    return undefined

  return {
    cron: '* * * * *',
    event: DIRECT_UPDATE_WITHOUT_DELTA_BENTO_EVENT,
    preferenceKey: 'direct_update_without_delta',
    uniqId: `${DIRECT_UPDATE_WITHOUT_DELTA_BENTO_EVENT}:${input.appId}`,
    data: {
      org_id: input.orgId,
      org_name: input.orgName ?? '',
      app_id: input.appId,
      app_name: input.appName ?? '',
      ...(typeof input.tags?.external === 'boolean' ? { external: input.tags.external } : {}),
    },
  }
}
