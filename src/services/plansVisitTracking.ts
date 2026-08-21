import { sendEvent } from '~/services/tracking'

export function createPlansVisitTracker(sender: typeof sendEvent = sendEvent) {
  const trackedOrganizationIds = new Set<string>()

  return {
    track(orgId: string | null | undefined) {
      if (!orgId || trackedOrganizationIds.has(orgId))
        return false

      trackedOrganizationIds.add(orgId)
      void sender({
        channel: 'usage',
        event: 'User visit',
        org_id: orgId,
        tracking_version: 2,
        tags: { page: 'plans' },
      })
      return true
    },
  }
}
