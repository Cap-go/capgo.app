import type { Database } from '~/types/supabase.types'
import { invokeCapgoApi } from '~/services/capgoApi'

export type OrganizationListRow = Database['public']['Functions']['get_orgs_v7']['Returns'][number]

export async function fetchOrganizationsList() {
  return await invokeCapgoApi<OrganizationListRow[]>('private/orgs', {
    method: 'GET',
  })
}
