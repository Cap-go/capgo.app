import type { AppAdvisoryFeedResponse } from '../../supabase/functions/shared/security_advisory.ts'
import { invokeCapgoApi } from '~/services/capgoApi'

export type {
  Advisory,
  AdvisoryMatchStatus,
  AdvisorySeverity,
  AppAdvisoryFeedResponse,
  AppAdvisoryMatch,
} from '../../supabase/functions/shared/security_advisory.ts'

export async function fetchSecurityUpdatesFeed(appId: string) {
  const encoded = encodeURIComponent(appId)
  return invokeCapgoApi<AppAdvisoryFeedResponse>(`private/security_updates/feed?app_id=${encoded}`, {
    method: 'GET',
  })
}
