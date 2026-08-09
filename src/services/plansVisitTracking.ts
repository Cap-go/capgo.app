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
        icon: '💳',
        org_id: orgId,
        tracking_version: 2,
        notify: false,
        tags: { page: 'plans' },
      })
      return true
    },
  }
}
