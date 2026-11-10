import type { AdminSecurityUpdatesTrackingResponse } from '../../supabase/functions/_backend/utils/security_advisory_admin_tracking.ts'
import { invokeCapgoApi } from './capgoApi'

export type { AdminSecurityUpdatesTrackingResponse }

export async function fetchAdminSecurityUpdatesTracking() {
  return await invokeCapgoApi<AdminSecurityUpdatesTrackingResponse>('private/admin_security_updates/tracking', {
    method: 'GET',
  })
}
