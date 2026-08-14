import { describe, expect, it } from 'vitest'
import { getRoleCapabilityKeys, splitCapabilityList } from '../src/services/roleCapabilities'

describe('roleCapabilities', () => {
  it.concurrent('returns i18n keys for known roles', () => {
    expect(getRoleCapabilityKeys('org_member')).toEqual({
      summaryKey: 'role-cap-org_member-summary',
      canKey: 'role-cap-org_member-can',
      cannotKey: 'role-cap-org_member-cannot',
    })
    expect(getRoleCapabilityKeys('app_admin')?.summaryKey).toBe('role-cap-app_admin-summary')
    expect(getRoleCapabilityKeys('apikey_manager')?.canKey).toBe('role-cap-apikey_manager-can')
    expect(getRoleCapabilityKeys('channel_reader')?.cannotKey).toBe('role-cap-channel_reader-cannot')
  })

  it.concurrent('returns null for unknown or empty roles', () => {
    expect(getRoleCapabilityKeys(null)).toBeNull()
    expect(getRoleCapabilityKeys('')).toBeNull()
    expect(getRoleCapabilityKeys('not_a_role')).toBeNull()
  })

  it.concurrent('splits pipe-separated capability lists', () => {
    expect(splitCapabilityList('Create apps|Manage API keys')).toEqual([
      'Create apps',
      'Manage API keys',
    ])
    expect(splitCapabilityList('  One | Two |  ')).toEqual(['One', 'Two'])
    expect(splitCapabilityList('')).toEqual([])
    expect(splitCapabilityList(null)).toEqual([])
  })
})
