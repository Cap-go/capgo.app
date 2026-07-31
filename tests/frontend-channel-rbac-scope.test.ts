import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

async function readRepoFile(path: string) {
  return await readFile(`${repoRoot}${path}`, 'utf8')
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function channelScopedCheckPermissionsCall(permission: string, appId: string, channelId: string) {
  return new RegExp(
    `checkPermissions\\(\\s*['\"]${escapeRegExp(permission)}['\"]\\s*,\\s*\\{(?=[^}]*\\bappId\\s*:\\s*${escapeRegExp(appId)}(?=\\s*[,}]))(?=[^}]*\\bchannelId\\s*:\\s*${escapeRegExp(channelId)}(?=\\s*[,}]))[^}]*\\}\\s*\\)`,
  )
}

function appOnlyCheckPermissionsCall(permission: string, appId: string) {
  return new RegExp(
    `checkPermissions\\(\\s*['\"]${escapeRegExp(permission)}['\"]\\s*,\\s*\\{\\s*appId\\s*:\\s*${escapeRegExp(appId)}\\s*,?\\s*\\}\\s*\\)`,
  )
}

function expectChannelPermissionDefaults(source: string, roleName: string, expected: Record<string, boolean>) {
  const roleBlock = source.match(new RegExp(`\\b${escapeRegExp(roleName)}\\s*:\\s*\\{([\\s\\S]*?)\\}\\s*,`, 'm'))?.[1]
  expect(roleBlock).toBeDefined()

  for (const [permission, allowed] of Object.entries(expected)) {
    expect(roleBlock).toMatch(new RegExp(`['\"]${escapeRegExp(permission)}['\"]\\s*:\\s*${allowed}`))
  }
}

describe('frontend channel RBAC scope regressions', () => {
  it.concurrent('checks channel settings updates at channel scope', async () => {
    const source = await readRepoFile('src/pages/app/[app].channel.[channel].vue')

    const permission = 'channel.update_settings'
    expect(source).toMatch(channelScopedCheckPermissionsCall(permission, 'packageId.value', 'id.value'))
    expect(source).not.toMatch(appOnlyCheckPermissionsCall(permission, 'packageId.value'))
  })

  it.concurrent('uses row-scoped channel permissions in the channel table actions', async () => {
    const source = await readRepoFile('src/components/tables/ChannelTable.vue')

    const permission = 'channel.delete'
    expect(source).toMatch(channelScopedCheckPermissionsCall(permission, 'props.appId', 'row.id'))
    expect(source).toMatch(channelScopedCheckPermissionsCall(permission, 'props.appId', 'one.id'))
    expect(source).toMatch(/disabled\s*:\s*\(\s*elem\s*:\s*Element\s*\)\s*=>\s*!\s*canReadChannel\.value\[elem\.id\]/)
    expect(source).toMatch(/visible\s*:\s*\(\s*elem\s*:\s*Element\s*\)\s*=>\s*!!\s*canDeleteChannel\.value\[elem\.id\]/)
    expect(source).not.toMatch(appOnlyCheckPermissionsCall(permission, 'props.appId'))
  })

  it.concurrent('keeps app reader channel defaults aligned with RBAC role permissions', async () => {
    const source = await readRepoFile('src/components/permissions/ChannelPermissionOverridesPanel.vue')

    expectChannelPermissionDefaults(source, 'app_reader', {
      'channel.read': false,
      'channel.read_history': false,
      'channel.promote_bundle': false,
    })
  })

  it.concurrent('keeps app preview channel defaults denied until a channel-specific grant exists', async () => {
    const source = await readRepoFile('src/components/permissions/ChannelPermissionOverridesPanel.vue')

    expectChannelPermissionDefaults(source, 'app_preview', {
      'channel.read': false,
      'channel.read_history': false,
      'channel.promote_bundle': false,
    })
  })

  it.concurrent('keeps preview channel defaults aligned with its channel-scoped RBAC role permissions', async () => {
    const source = await readRepoFile('src/components/permissions/ChannelPermissionOverridesPanel.vue')

    expectChannelPermissionDefaults(source, 'channel_preview', {
      'channel.read': true,
      'channel.read_history': false,
      'channel.promote_bundle': true,
    })
  })

  it.concurrent('keeps app-only keys in their owner organization filter without showing an organization role', async () => {
    const source = await readRepoFile('src/pages/ApiKeys.vue')

    expect(source).toMatch(/if\s*\(\s*binding\.scope_type\s*===\s*['"]app['"]\s*&&\s*binding\.org_id\s*\)/)
    expect(source).toMatch(/const\s+orgIds\s*=\s*getFilterOrgIds\s*\(\s*key\s*\)/)
    expect(source).toMatch(/binding\.scope_type\s*===\s*['"]org['"]\s*&&\s*binding\.org_id\s*&&\s*binding\.role_name\s*!==\s*systemApiKeyOrgReaderRole/)
    expect(source).toMatch(/const\s+directOrgBindings\s*=\s*bindings\.filter\(\s*binding\s*=>\s*binding\.scope_type\s*===\s*['"]org['"]\s*&&\s*binding\.role_name\s*!==\s*systemApiKeyOrgReaderRole\s*,?\s*\)/)
  })
})
