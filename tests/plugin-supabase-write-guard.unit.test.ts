import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const { cloudlogMock } = vi.hoisted(() => ({
  cloudlogMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
  cloudlogErr: vi.fn(),
  serializeError: vi.fn(error => error),
}))

function createContext(flags: Partial<Record<'skipSupabaseStatsFallback' | 'skipSupabaseNotificationWrites' | 'queuePluginNotifications' | 'skipChannelSelfPostgresFallback' | 'requireReadReplica', boolean>> = {}, env: Record<string, any> = {}) {
  return {
    env,
    get: (key: string) => {
      if (key in flags)
        return flags[key as keyof typeof flags]
      if (key === 'requestId')
        return 'request-id'
      return undefined
    },
    req: {
      raw: {
        cf: {},
        headers: new Headers(),
      },
      url: 'http://localhost/test',
    },
    res: {
      headers: new Headers(),
    },
  } as any
}

function createPluginPolicyContext(env: Record<string, any> = {}) {
  return createContext({
    skipSupabaseStatsFallback: true,
    skipSupabaseNotificationWrites: true,
    queuePluginNotifications: true,
    skipChannelSelfPostgresFallback: true,
    requireReadReplica: true,
  }, env)
}

interface WranglerConfig {
  triggers?: { crons: string[] }
  env: Record<string, {
    triggers?: { crons: string[] }
    kv_namespaces?: { binding: string, id: string }[]
    hyperdrive?: { binding: string, id: string }[]
  }>
}

function stripJsoncComments(raw: string) {
  let result = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    const next = raw[index + 1]

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        result += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === '\n')
        result += char
      if (char === '*' && next === '/') {
        inBlockComment = false
        index++
      }
      continue
    }

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"')
        inString = false
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === '/' && next === '/') {
      inLineComment = true
      index++
      continue
    }

    if (char === '/' && next === '*') {
      inBlockComment = true
      index++
      continue
    }

    result += char
  }

  return result
}

function readJsoncConfig(path: string) {
  const raw = readFileSync(new URL(path, import.meta.url), 'utf8')
  return JSON.parse(stripJsoncComments(raw)) as WranglerConfig
}

function getKvNamespaceId(config: WranglerConfig, envName: string, binding: string) {
  return config.env[envName]?.kv_namespaces?.find(namespace => namespace.binding === binding)?.id
}

function getHyperdriveId(config: WranglerConfig, envName: string, binding: string) {
  return config.env[envName]?.hyperdrive?.find(hyperdrive => hyperdrive.binding === binding)?.id
}

describe('plugin Supabase write policy', () => {
  it.concurrent('keeps notification queue KV separate and cron owned by the API worker', () => {
    const pluginWrangler = readJsoncConfig('../cloudflare_workers/plugin/wrangler.jsonc')
    const apiWrangler = readJsoncConfig('../cloudflare_workers/api/wrangler.jsonc')

    expect(pluginWrangler.triggers).toBeUndefined()
    expect(Object.values(pluginWrangler.env).every(env => env.triggers === undefined)).toBe(true)

    for (const envName of ['prod', 'preprod', 'alpha', 'local'])
      expect(apiWrangler.env[envName]?.triggers).toEqual({ crons: ['* * * * *'] })

    for (const envName of ['prod', 'preprod', 'alpha'])
      expect(getHyperdriveId(apiWrangler, envName, 'HYPERDRIVE_CAPGO_DIRECT_EU')).toBe('ae1fe6178b564adc9fc9a71ccc769a35')

    for (const envName of Object.keys(pluginWrangler.env))
      expect(getHyperdriveId(pluginWrangler, envName, 'HYPERDRIVE_CAPGO_DIRECT_EU')).toBeUndefined()

    const envPairs = [
      ['prod', 'prod_eu'],
      ['prod', 'prod_na'],
      ['prod', 'prod_sa'],
      ['prod', 'prod_oc'],
      ['prod', 'prod_as'],
      ['prod', 'prod_af'],
      ['prod', 'prod_me'],
      ['prod', 'prod_hk'],
      ['prod', 'prod_jp'],
      ['preprod', 'preprod'],
      ['alpha', 'alpha'],
      ['local', 'local'],
    ] as const

    for (const [apiEnv, pluginEnv] of envPairs) {
      const apiQueueId = getKvNamespaceId(apiWrangler, apiEnv, 'PLUGIN_NOTIFICATION_QUEUE')
      const pluginQueueId = getKvNamespaceId(pluginWrangler, pluginEnv, 'PLUGIN_NOTIFICATION_QUEUE')
      expect(apiQueueId).toBe(pluginQueueId)
      expect(apiQueueId).toBeTruthy()
      expect(apiQueueId).not.toBe(getKvNamespaceId(apiWrangler, apiEnv, 'CHANNEL_SELF_STORE'))
      expect(pluginQueueId).not.toBe(getKvNamespaceId(pluginWrangler, pluginEnv, 'CHANNEL_SELF_STORE'))
    }
  })

  it.concurrent('fails closed instead of falling back from read replica to primary', async () => {
    const { getPgClient } = await import('../supabase/functions/_backend/utils/pg.ts')

    expect(() => getPgClient(createPluginPolicyContext(), true)).toThrow('Read replica is required for this endpoint')
  })

  it('skips direct Hyperdrive fallback in plugin policy contexts', async () => {
    const { getDatabaseURL } = await import('../supabase/functions/_backend/utils/pg.ts')
    const previousMainDbUrl = process.env.MAIN_SUPABASE_DB_URL
    process.env.MAIN_SUPABASE_DB_URL = 'postgres://main-pooler'
    const context = createPluginPolicyContext({
      HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      SUPABASE_DB_URL: 'postgres://supabase-direct',
    })

    try {
      expect(getDatabaseURL(context)).toBe('postgres://main-pooler')
      expect(cloudlogMock).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Skipping HYPERDRIVE_CAPGO_DIRECT_EU fallback for this endpoint',
      }))
    }
    finally {
      if (previousMainDbUrl === undefined)
        delete process.env.MAIN_SUPABASE_DB_URL
      else
        process.env.MAIN_SUPABASE_DB_URL = previousMainDbUrl
    }
  })

  it.concurrent('keeps direct Hyperdrive fallback available outside plugin policy contexts', async () => {
    const { getDatabaseURL } = await import('../supabase/functions/_backend/utils/pg.ts')
    const context = createContext({}, {
      HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      MAIN_SUPABASE_DB_URL: 'postgres://main-pooler',
      SUPABASE_DB_URL: 'postgres://supabase-direct',
    })

    expect(getDatabaseURL(context)).toBe('postgres://direct-hyperdrive')
  })

  it.concurrent('skips Supabase stats fallbacks when Cloudflare analytics bindings are absent', async () => {
    const { createStatsBandwidth, createStatsDevices, createStatsLogs, createStatsLogsExternal, createStatsMau, createStatsVersion } = await import('../supabase/functions/_backend/utils/stats.ts')
    const context = createPluginPolicyContext()

    await expect(createStatsMau(context, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0')).resolves.toBeUndefined()
    await expect(createStatsVersion(context, '1.0.0', 'com.test.app', 'get')).resolves.toBeUndefined()
    await expect(createStatsLogs(context, 'com.test.app', 'device-1', 'get', '1.0.0')).resolves.toBeUndefined()
    await expect(createStatsLogsExternal(context, 'com.test.app', 'device-1', 'get', '1.0.0')).resolves.toBeUndefined()
    await expect(createStatsDevices(context, {
      app_id: 'com.test.app',
      device_id: '00000000-0000-4000-8000-000000000001',
      version_name: '1.0.0',
      version_build: '1.0.0',
      platform: 'ios',
      plugin_version: '7.0.0',
      os_version: '17.0',
      custom_id: '',
      is_prod: true,
      is_emulator: false,
      default_channel: null,
      updated_at: new Date().toISOString(),
    })).resolves.toBeUndefined()
    await expect(createStatsBandwidth(context, 'device-1', 'com.test.app', 42)).resolves.toBeUndefined()
  })

  it.concurrent('skips notification table writes for plugin requests', async () => {
    const { claimNotifOrgOnce, sendNotifOrgOnce } = await import('../supabase/functions/_backend/utils/notifications.ts')
    const { sendNotifToOrgMembersOnce } = await import('../supabase/functions/_backend/utils/org_email_notifications.ts')
    const context = createPluginPolicyContext()

    await expect(claimNotifOrgOnce(context, 'org:missing_payment', 'org-1', 'uniq-1')).resolves.toBe(false)
    await expect(sendNotifOrgOnce(context, 'org:missing_payment', {}, 'org-1', 'uniq-1', 'owner@example.com', {} as any)).resolves.toEqual({ sent: false, cleanupFailed: false })
    await expect(sendNotifToOrgMembersOnce(context, 'org:missing_payment', 'usage_limit', {}, 'org-1', 'uniq-1', {} as any)).resolves.toBe(false)
  })

  it.concurrent('blocks legacy channel_self PostgreSQL storage fallback in the Worker route', async () => {
    const { Hono } = await import('hono/tiny')
    const { app: channelSelfApp } = await import('../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts')
    const wrapper = new Hono()
    wrapper.use('*', async (c, next) => {
      ;(c as any).set('skipSupabaseStatsFallback', true)
      ;(c as any).set('skipSupabaseNotificationWrites', true)
      ;(c as any).set('queuePluginNotifications', true)
      ;(c as any).set('skipChannelSelfPostgresFallback', true)
      ;(c as any).set('requireReadReplica', true)
      await next()
    })
    wrapper.route('/channel_self', channelSelfApp)

    const response = await wrapper.request('/channel_self', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: 'com.test.app',
        device_id: '00000000-0000-4000-8000-000000000001',
        version_name: '1.0.0',
        version_build: '1.0.0',
        version_os: '17.0',
        platform: 'ios',
        is_emulator: false,
        is_prod: true,
        plugin_version: '7.33.0',
        channel: 'beta',
      }),
    })

    await expect(response.json()).resolves.toMatchObject({
      error: 'channel_self_server_storage_unavailable',
    })
  })

  it.concurrent('does not use channel_self KV or fall back to DB notifications when plugin queue KV is missing', async () => {
    const { sendNotifOrgCached } = await import('../supabase/functions/_backend/utils/notifications.ts')
    const channelSelfGet = vi.fn(async () => null)
    const channelSelfPut = vi.fn(async () => undefined)
    const context = createContext({ queuePluginNotifications: true }, { CHANNEL_SELF_STORE: { get: channelSelfGet, put: channelSelfPut } })
    const drizzleClient = {
      insert: vi.fn(() => {
        throw new Error('normal notification path called')
      }),
    } as any

    await expect(sendNotifOrgCached(context, 'org:missing_payment', { app_id: 'com.test.app' }, 'org-1', 'com.test.app', '0 0 * * 1', 'owner@example.com', drizzleClient)).resolves.toBe(false)

    expect(channelSelfGet).not.toHaveBeenCalled()
    expect(channelSelfPut).not.toHaveBeenCalled()
    expect(drizzleClient.insert).not.toHaveBeenCalled()
  })

  it.concurrent('does not rewrite plugin notification KV when the deterministic key already exists', async () => {
    const get = vi.fn(async (_key: string) => '{"queued":true}')
    const put = vi.fn(async (_key: string, _raw: string, _options: unknown) => undefined)
    const context = createContext({ queuePluginNotifications: true }, { PLUGIN_NOTIFICATION_QUEUE: { get, put } })
    const { sendNotifOrgCached } = await import('../supabase/functions/_backend/utils/notifications.ts')

    await expect(sendNotifOrgCached(context, 'org:missing_payment', { app_id: 'com.test.app' }, 'org-1', 'com.test.app', '0 0 * * 1', 'owner@example.com', {} as any)).resolves.toBe(false)

    expect(get).toHaveBeenCalledTimes(1)
    expect(put).not.toHaveBeenCalled()
  })

  it.concurrent('does not enqueue plugin notifications while a KV throttle marker exists', async () => {
    const get = vi.fn(async (key: string) => key.startsWith('plugin:notif:throttle:v1:') ? 'throttled' : null)
    const put = vi.fn(async (_key: string, _raw: string, _options: unknown) => undefined)
    const context = createContext({ queuePluginNotifications: true }, { PLUGIN_NOTIFICATION_QUEUE: { get, put } })
    const { sendNotifOrgCached } = await import('../supabase/functions/_backend/utils/notifications.ts')

    await expect(sendNotifOrgCached(context, 'org:missing_payment', { app_id: 'com.test.app' }, 'org-1', 'com.test.app', '0 0 * * 1', 'owner@example.com', {} as any)).resolves.toBe(false)

    expect(get.mock.calls.some(([key]) => String(key).startsWith('plugin:notif:throttle:v1:'))).toBe(true)
    expect(put).not.toHaveBeenCalled()
  })

  it.concurrent('queues cached org notifications into plugin KV', async () => {
    const get = vi.fn(async (_key: string) => null)
    const put = vi.fn(async (_key: string, _raw: string, _options: unknown) => undefined)
    const context = createContext({ queuePluginNotifications: true }, { PLUGIN_NOTIFICATION_QUEUE: { get, put } })
    const { sendNotifOrgCached } = await import('../supabase/functions/_backend/utils/notifications.ts')

    await expect(sendNotifOrgCached(context, 'org:missing_payment', { app_id: 'com.test.app' }, 'org-1', 'com.test.app', '0 0 * * 1', 'owner@example.com', {} as any)).resolves.toBe(false)

    expect(put).toHaveBeenCalledTimes(1)
    const [key, raw, options] = put.mock.calls[0]
    expect(get).toHaveBeenCalledWith(key)
    expect(key).toMatch(/^plugin:notif:v1:org:/)
    expect(JSON.parse(raw as string)).toMatchObject({
      type: 'org',
      eventName: 'org:missing_payment',
      orgId: 'org-1',
      uniqId: 'com.test.app',
      managementEmail: 'owner@example.com',
    })
    expect(options).toMatchObject({ expirationTtl: 604800 })
  })

  it.concurrent('queues cached org member notifications into plugin KV', async () => {
    const get = vi.fn(async (_key: string) => null)
    const put = vi.fn(async (_key: string, _raw: string, _options: unknown) => undefined)
    const context = createContext({ queuePluginNotifications: true }, { PLUGIN_NOTIFICATION_QUEUE: { get, put } })
    const { sendNotifToOrgMembersCached } = await import('../supabase/functions/_backend/utils/org_email_notifications.ts')

    await expect(sendNotifToOrgMembersCached(context, 'device:channel_self_set_rejected', 'channel_self_rejected', { app_id: 'com.test.app' }, 'org-1', 'com.test.app', '0 0 * * 0', {} as any)).resolves.toBe(false)

    expect(put).toHaveBeenCalledTimes(1)
    const [key, raw, options] = put.mock.calls[0]
    expect(get).toHaveBeenCalledWith(key)
    expect(key).toMatch(/^plugin:notif:v1:org_members:/)
    expect(JSON.parse(raw as string)).toMatchObject({
      type: 'org_members',
      eventName: 'device:channel_self_set_rejected',
      preferenceKey: 'channel_self_rejected',
      orgId: 'org-1',
      uniqId: 'com.test.app',
      audience: 'admins',
    })
    expect(options).toMatchObject({ expirationTtl: 604800 })
  })
})
