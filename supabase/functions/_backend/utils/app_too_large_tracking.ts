import type { BentoTrackingPayload } from './tracking.ts'
import { ALERT_UPLOAD_SIZE_BYTES } from '../files/util.ts'

/**
 * CLI `bundle upload` emits this when the zipped bundle is over the alert
 * threshold (20 MB) but still under the hard max, and the zip is actually
 * uploaded (`--delta-only` / `--partial-only` skip it). PostHog already
 * records it; this helper builds the Bento payload so org admins can get a
 * lifecycle automation / email.
 */
export const APP_TOO_LARGE_EVENT = 'App Too Large'
export const APP_TOO_LARGE_BENTO_EVENT = 'app_too_large'
/** Fallback for CLIs that do not send `recommended_size_mb` (same 20 MB alert threshold). */
export const APP_TOO_LARGE_RECOMMENDED_SIZE_MB = Math.floor(ALERT_UPLOAD_SIZE_BYTES / 1024 / 1024)

export interface AppTooLargeBentoInput {
  event: string
  orgId: string | undefined
  appId: string | undefined
  orgName?: string
  appName?: string
  tags?: Record<string, string | number | boolean>
}

function toSizeMb(tags: Record<string, string | number | boolean> | undefined, key: string): number | undefined {
  const raw = tags?.[key]
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0)
    return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length > 0) {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed) && parsed >= 0)
        return parsed
    }
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

  const sizeMb = toSizeMb(input.tags, 'size_mb')
  const recommendedSizeMb = toSizeMb(input.tags, 'recommended_size_mb') || APP_TOO_LARGE_RECOMMENDED_SIZE_MB

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
      recommended_size_mb: recommendedSizeMb,
      ...(sizeMb === undefined
        ? {}
        : {
            size_mb: sizeMb,
            size_over_recommended_mb: Math.max(0, sizeMb - recommendedSizeMb),
            size_ratio: Math.round((sizeMb / recommendedSizeMb) * 10) / 10,
          }),
    },
  }
}
