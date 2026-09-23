import { invokeCapgoApi } from '~/services/capgoApi'

export interface AssignableRole {
  id: string
  name: string
  scope_type: string
  description: string
  priority_rank: number
  is_assignable: boolean
}

export async function fetchAssignableRolesByScope(scopeType: 'app' | 'org' | 'channel') {
  return await invokeCapgoApi<AssignableRole[]>(`private/roles/${scopeType}`, {
    method: 'GET',
  })
}

export async function fetchAssignableRoles(scopeTypes?: Array<'app' | 'org' | 'channel'>) {
  const { data, error } = await invokeCapgoApi<AssignableRole[]>('private/roles', {
    method: 'GET',
  })

  if (error || !data)
    return { data, error }

  if (!scopeTypes || scopeTypes.length === 0)
    return { data, error: null }

  const allowedScopes = new Set(scopeTypes)
  const filtered = data
    .filter(role => allowedScopes.has(role.scope_type as 'app' | 'org' | 'channel'))
    .sort((left, right) => right.priority_rank - left.priority_rank)

  return { data: filtered, error: null }
}
