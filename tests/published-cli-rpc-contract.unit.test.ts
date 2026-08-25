import { describe, expect, it } from 'vitest'
import {
  comparePublishedCliTags,
  extractPublishedCliRpcCallsFromSource,
  resolvePublishedCliNpmVersion,
  rpcCallMatchesOverload,
} from '../scripts/published-cli-contract.ts'

describe('published CLI contract helpers', () => {
  it.concurrent('sorts cli tags by semver', () => {
    expect(comparePublishedCliTags('cli-8.42.4', 'cli-8.42.5')).toBeLessThan(0)
    expect(comparePublishedCliTags('cli-8.42.5', 'cli-8.42.5')).toBe(0)
    expect(comparePublishedCliTags('cli-8.43.0', 'cli-8.42.5')).toBeGreaterThan(0)
  })

  it.concurrent('maps cli tags to npm versions', () => {
    expect(resolvePublishedCliNpmVersion('cli-8.42.5')).toBe('8.42.5')
  })

  it.concurrent('extracts rpc calls and argument keys from CLI source', () => {
    const source = `
      await supabase.rpc('get_user_id', { apikey }).single()
      await supabase.rpc('get_orgs_v7')
      await supabase.rpc('cli_check_permission' as any, {
        apikey,
        permission_key: permissionKey,
        org_id: scope.orgId ?? null,
        app_id: scope.appId ?? null,
        channel_id: scope.channelId ?? null,
      })
    `

    expect(extractPublishedCliRpcCallsFromSource(source)).toEqual([
      { name: 'cli_check_permission', argKeys: ['apikey', 'app_id', 'channel_id', 'org_id', 'permission_key'] },
      { name: 'get_orgs_v7', argKeys: [] },
      { name: 'get_user_id', argKeys: ['apikey'] },
    ])
  })

  it.concurrent('matches postgrest overloads from provided rpc argument keys', () => {
    expect(rpcCallMatchesOverload(
      { name: 'get_user_id', argKeys: ['apikey'] },
      ['apikey'],
      0,
      1,
    )).toBe(true)

    expect(rpcCallMatchesOverload(
      { name: 'get_user_id', argKeys: ['apikey', 'app_id'] },
      ['apikey', 'app_id'],
      0,
      2,
    )).toBe(true)

    expect(rpcCallMatchesOverload(
      { name: 'get_user_id', argKeys: ['apikey'] },
      ['apikey', 'app_id'],
      0,
      2,
    )).toBe(false)

    expect(rpcCallMatchesOverload(
      { name: 'get_orgs_v7', argKeys: [] },
      [],
      0,
      0,
    )).toBe(true)
  })
})
