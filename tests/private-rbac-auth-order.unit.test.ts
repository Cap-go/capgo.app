import { describe, expect, it } from 'vitest'
import { app as groupsApp } from '../supabase/functions/_backend/private/groups.ts'
import { app as roleBindingsApp } from '../supabase/functions/_backend/private/role_bindings.ts'
import { app as rolesApp } from '../supabase/functions/_backend/private/roles.ts'

function postJson(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('private RBAC auth ordering', () => {
  it.concurrent.each([
    ['invalid group params', () => groupsApp.request('http://localhost/not-a-uuid')],
    ['invalid group-member bodies', () => groupsApp.request(postJson('http://localhost/550e8400-e29b-41d4-a716-446655440000/members', { user_id: 'not-a-uuid' }))],
    ['invalid role binding params', () => roleBindingsApp.request('http://localhost/not-a-uuid')],
    ['invalid role binding bodies', () => roleBindingsApp.request(postJson('http://localhost/', {
      principal_type: 'device',
      principal_id: 'not-a-uuid',
      role_name: '',
      scope_type: 'invalid',
      org_id: 'not-a-uuid',
    }))],
    ['invalid role scope params', () => rolesApp.request('http://localhost/not-a-scope')],
  ])('returns 401 before validating %s', async (_label, send) => {
    const response = await send()
    expect(response.status).toBe(401)
  })
})
