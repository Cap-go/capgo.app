import { describe, expect, it } from 'vitest'
import {
  comparePublishedCliTags,
  extractPublishedCliRpcCallsFromSource,
  resolveLatestPublishedCliTag,
  resolvePublishedCliNpmInstallVersion,
  resolvePublishedCliRpcSourceTag,
  rpcCallMatchesOverload,
} from '../scripts/published-cli-contract.ts'

describe('published CLI contract helpers', () => {
  it.concurrent('sorts cli tags by semver', () => {
    expect(comparePublishedCliTags('cli-8.42.4', 'cli-8.42.5')).toBeLessThan(0)
    expect(comparePublishedCliTags('cli-8.42.5', 'cli-8.42.5')).toBe(0)
    expect(comparePublishedCliTags('cli-8.43.0', 'cli-8.42.5')).toBeGreaterThan(0)
    expect(comparePublishedCliTags('cli-8.42.5', 'cli-8.42.5-rc.1')).toBeGreaterThan(0)
  })

  it.concurrent('prefers stable cli tags over prerelease tags with the same version', () => {
    const tag = resolveLatestPublishedCliTag((args) => {
      if (args[0] === 'tag')
        return 'cli-8.42.5-rc.1\ncli-8.42.5\ncli-8.42.4'
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    })

    expect(tag).toBe('cli-8.42.5')
  })

  it.concurrent('uses the git tag matching the npm package under test for rpc extraction', () => {
    const sourceTag = resolvePublishedCliRpcSourceTag('cli-8.42.5', '8.42.3', (args) => {
      if (args[0] === 'rev-parse')
        return 'ok'
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    })

    expect(sourceTag).toBe('cli-8.42.3')
  })

  it.concurrent('ignores cli-helper tags when resolving the latest published CLI tag', () => {
    const tag = resolveLatestPublishedCliTag((args) => {
      if (args[0] === 'tag')
        return 'cli-helper-1.1.1-rc.1\ncli-8.42.4\ncli-8.42.5'
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    })

    expect(tag).toBe('cli-8.42.5')
  })

  it.concurrent('uses the highest published npm version at or below the git tag', () => {
    const version = resolvePublishedCliNpmInstallVersion('cli-8.42.5', (args) => {
      expect(args).toEqual(['view', '@capgo/cli', 'versions', '--json'])
      return JSON.stringify(['8.42.1', '8.42.2', '8.42.3'])
    })

    expect(version).toBe('8.42.3')
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

  it.concurrent('extracts multiline rpc args from chained supabase calls', () => {
    const source = `
      const { data: bundleRows } = await withSupabaseSource('channels.currentBundleName', () => supabase
        .rpc('get_channel_current_bundle_rbac' as any, {
          p_app_id: appId,
          p_channel_id: channelId,
        }))
    `

    expect(extractPublishedCliRpcCallsFromSource(source)).toEqual([
      { name: 'get_channel_current_bundle_rbac', argKeys: ['p_app_id', 'p_channel_id'] },
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

    expect(rpcCallMatchesOverload(
      { name: 'get_channel_current_bundle_rbac', argKeys: [] },
      ['p_app_id', 'p_channel_id'],
      0,
      2,
    )).toBe(true)
  })
})
