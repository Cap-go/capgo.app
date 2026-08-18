import type { BentoTrackingPayload } from './tracking.ts'

/**
 * CLI `bundle upload` emits this when the zipped bundle is over the alert
 * threshold (20 MB) but still under the hard max. PostHog already records it;
 * this helper builds the Bento payload so org admins can get a lifecycle
 * automation / email.
 */
export const APP_TOO_LARGE_EVENT = 'App Too Large'
export const APP_TOO_LARGE_BENTO_EVENT = 'app_too_large'

export interface AppTooLargeBentoInput {
  event: string
  orgId: string | undefined
  appId: string | undefined
  orgName?: string
  appName?: string
  tags?: Record<string, string | number | boolean>
}

function toSizeMb(tags: Record<string, string | number | boolean> | undefined): number | undefined {
  const raw = tags?.size_mb
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0)
    return raw
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0)
      return parsed
  }
  return undefined
}

/**
 * Pure: emit a Bento signal for oversized bundle uploads. Returns undefined
 * when the event name does not match or org/app context is missing.
 */
export function buildAppTooLargeBentoEvent(input: AppTooLargeBentoInput): BentoTrackingPayload | undefined {
  if (input.event !== APP_TOO_LARGE_EVENT)
    return undefined
  if (!input.orgId || !input.appId)
    return undefined

  const sizeMb = toSizeMb(input.tags)

  return {
    cron: '* * * * *',
    event: APP_TOO_LARGE_BENTO_EVENT,
    preferenceKey: 'app_too_large',
    uniqId: `${APP_TOO_LARGE_BENTO_EVENT}:${input.appId}`,
    data: {
      org_id: input.orgId,
      org_name: input.orgName ?? '',
      app_id: input.appId,
      app_name: input.appName ?? '',
      ...(sizeMb === undefined ? {} : { size_mb: sizeMb }),
    },
  }
}
