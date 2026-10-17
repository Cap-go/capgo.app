import type { Context } from 'hono'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCliRequestHeaders,
  CAPGO_CLI_API_VERSION,
  getCurrentCliCommand,
  setCurrentCliCommand,
} from '../cli/src/analytics/cli-headers.ts'
import pack from '../cli/package.json'
import { hasCliUsageIngest, resolveCliUsageIdentity, trackCliUsage } from '../supabase/functions/_backend/utils/cli_usage.ts'

const {
  cloudlogErrMock,
  checkKeyMock,
} = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  checkKeyMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: cloudlogErrMock,
  serializeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  checkKey: checkKeyMock,
  supabaseAdmin: vi.fn(() => ({})),
}))

function createContext(env: Record<string, unknown> = {}) {
  return {
    env,
    get: vi.fn((key: string) => key === 'requestId' ? 'test-request' : undefined),
  } as unknown as Context
}

describe('buildCliRequestHeaders', () => {
  afterEach(() => {
    setCurrentCliCommand('')
  })

  it('includes version, command, node, and os headers', () => {
    setCurrentCliCommand('bundle upload')
    const headers = buildCliRequestHeaders()
    expect(headers.capgo_api).toBe('2025-10-01')
    expect(headers.capgo_api).toBe(CAPGO_CLI_API_VERSION)
    expect(headers['x-cli-version']).toBe(pack.version)
    expect(headers['x-cli-command']).toBe('bundle upload')
    expect(headers['x-cli-node']).toBeTruthy()
    expect(headers['x-cli-os']).toBeTruthy()
    expect(headers.capgkey).toBeUndefined()
  })

  it('merges extra headers without inventing apikey', () => {
    const headers = buildCliRequestHeaders({ Authorization: 'Bearer x', capgkey: 'key-1' })
    expect(headers.Authorization).toBe('Bearer x')
    expect(headers.capgkey).toBe('key-1')
    expect(headers['x-cli-version']).toBe(pack.version)
  })

  it('tracks command via setters', () => {
    setCurrentCliCommand('app list')
    expect(getCurrentCliCommand()).toBe('app list')
  })
})

describe('trackCliUsage', () => {
  const event = {
    cli_version: '8.32.8',
    command: 'bundle upload',
    node_version: 'v22.0.0',
    os_platform: 'darwin',
    apikey_id: '00000000-0000-4000-8000-000000000001',
    org_id: null,
    source: 'config' as const,
    api_version: '2025-10-01',
  }

  beforeEach(() => {
    cloudlogErrMock.mockReset()
  })

  it('skips entirely when cli_version is empty', async () => {
    const record = vi.fn()
    await trackCliUsage(createContext({ ADMIN_CLI_USAGE: { record } }), { ...event, cli_version: '' })
    expect(record).not.toHaveBeenCalled()
  })

  it('forwards the event to the admin dashboard RPC binding', async () => {
    const record = vi.fn().mockResolvedValue({ recorded: true })
    const c = createContext({ ADMIN_CLI_USAGE: { record } })
    expect(hasCliUsageIngest(c)).toBe(true)
    await trackCliUsage(c, event)
    expect(record).toHaveBeenCalledWith(event)
  })

  it('records nothing without the binding (preprod, local, Supabase)', async () => {
    const c = createContext({ CLI_USAGE: { writeDataPoint: vi.fn() } })
    expect(hasCliUsageIngest(c)).toBe(false)
    await expect(trackCliUsage(c, event)).resolves.toBeUndefined()
    expect(cloudlogErrMock).not.toHaveBeenCalled()
  })

  it('logs and swallows RPC failures', async () => {
    const record = vi.fn().mockRejectedValue(new Error('rpc down'))
    await expect(trackCliUsage(createContext({ ADMIN_CLI_USAGE: { record } }), event)).resolves.toBeUndefined()
    expect(cloudlogErrMock).toHaveBeenCalledTimes(1)
  })
})

describe('resolveCliUsageIdentity', () => {
  beforeEach(() => {
    cloudlogErrMock.mockReset()
    checkKeyMock.mockReset()
  })

  it('returns nulls when no capgkey is provided', async () => {
    const result = await resolveCliUsageIdentity(createContext(), undefined)
    expect(result).toEqual({ apikey_id: null, org_id: null })
    expect(checkKeyMock).not.toHaveBeenCalled()
  })

  it('returns rbac_id for a valid key', async () => {
    checkKeyMock.mockResolvedValue({ rbac_id: 'rbac-123' })
    const result = await resolveCliUsageIdentity(createContext(), 'capgo_key')
    expect(result).toEqual({ apikey_id: 'rbac-123', org_id: null })
    expect(checkKeyMock).toHaveBeenCalled()
  })

  it('returns nulls without throwing when checkKey rejects', async () => {
    checkKeyMock.mockRejectedValue(new Error('lookup failed'))
    await expect(resolveCliUsageIdentity(createContext(), 'bad-key')).resolves.toEqual({
      apikey_id: null,
      org_id: null,
    })
    expect(cloudlogErrMock).toHaveBeenCalled()
  })
})

describe('api worker CLI usage bindings', () => {
  const config = JSON.parse(readFileSync(new URL('../cloudflare_workers/api/wrangler.jsonc', import.meta.url), 'utf8'))

  it('binds only prod to the admin dashboard CliUsageIngest RPC entrypoint', () => {
    expect(config.env.prod.services).toContainEqual({
      binding: 'ADMIN_CLI_USAGE',
      service: 'capgo-admin-dashboard-api',
      entrypoint: 'CliUsageIngest',
    })
    for (const [name, environment] of Object.entries(config.env) as Array<[string, { services?: Array<{ binding: string }> }]>) {
      if (name !== 'prod')
        expect(environment.services?.some(service => service.binding === 'ADMIN_CLI_USAGE') ?? false).toBe(false)
    }
  })

  it('no longer writes the CLI_USAGE Analytics Engine dataset directly', () => {
    for (const environment of [config, ...Object.values(config.env)] as Array<{ analytics_engine_datasets?: Array<{ binding: string }> }>)
      expect(environment.analytics_engine_datasets?.some(dataset => dataset.binding === 'CLI_USAGE') ?? false).toBe(false)
  })
})
