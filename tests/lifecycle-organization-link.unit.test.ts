import { describe, expect, it } from 'vitest'
import { lifecycleOrganizationTarget } from '../src/utils/lifecycleOrganizationLink'

const id = '11111111-1111-4111-8111-111111111111'
const query = { oid: id, source: 'capgo_lifecycle' }
describe('lifecycle organization links', () => {
  it('selects an existing accepted membership for the recipient organization', () => {
    expect(lifecycleOrganizationTarget(query, [{ gid: id, role: 'admin', is_invite: false }])).toBe(id)
  })
  it('rejects missing, malformed, inaccessible and pending-invite organizations', () => {
    expect(lifecycleOrganizationTarget(query, [])).toBeNull()
    expect(lifecycleOrganizationTarget({ source: 'capgo_lifecycle', oid: 'invalid' }, [])).toBeNull()
    expect(lifecycleOrganizationTarget(query, [{ gid: id, role: 'invite_admin' }])).toBeNull()
    expect(lifecycleOrganizationTarget(query, [{ gid: id, role: 'admin', is_invite: true }])).toBeNull()
  })
  it('preserves existing links without the lifecycle attribution', () => {
    expect(lifecycleOrganizationTarget({ oid: id }, [])).toBeUndefined()
  })
})
