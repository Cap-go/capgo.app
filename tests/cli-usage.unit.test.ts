import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCliRequestHeaders,
  CAPGO_CLI_API_VERSION,
  getCurrentCliCommand,
  setCurrentCliCommand,
} from '../cli/src/analytics/cli-headers.ts'
import pack from '../cli/package.json'
import { resolveCliUsageIdentity, trackCliUsage } from '../supabase/functions/_backend/utils/cli_usage.ts'

const {
  backgroundTaskMock,
  cloudlogErrMock,
  checkKeyMock,
  getPgClientMock,
  closeClientMock,
  queryMock,
} = vi.hoisted(() => ({
  backgroundTaskMock: vi.fn(),
  cloudlogErrMock: vi.fn(),
  checkKeyMock: vi.fn(),
  getPgClientMock: vi.fn(),
  closeClientMock: vi.fn(),
  queryMock: vi.fn(),
}))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    getRuntimeKey: vi.fn(),
  }
})

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  backgroundTask: backgroundTaskMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: cloudlogErrMock,
  serializeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  checkKey: checkKeyMock,
  supabaseAdmin: vi.fn(() => ({})),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: getPgClientMock,
  closeClient: closeClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/cloudflare.ts', () => ({
  formatDateCF: (value: string) => value.replace('T', ' ').replace('Z', ''),
  runQueryToCFA: vi.fn(),
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
  beforeEach(() => {
    backgroundTaskMock.mockReset()
    backgroundTaskMock.mockImplementation((_c: unknown, promise: Promise<unknown>) => promise)
    cloudlogErrMock.mockReset()
    checkKeyMock.mockReset()
    getPgClientMock.mockReset()
    closeClientMock.mockReset()
    queryMock.mockReset()
    getPgClientMock.mockReturnValue({ query: queryMock })
    closeClientMock.mockResolvedValue(undefined)
    vi.mocked(getRuntimeKey).mockReset()
  })

  it('skips entirely when cli_version is empty', () => {
    vi.mocked(getRuntimeKey).mockReturnValue('workerd')
    const writeDataPoint = vi.fn()
    trackCliUsage(createContext({ CLI_USAGE: { writeDataPoint } }), {
      cli_version: '',
      command: 'bundle upload',
      node_version: 'v22.0.0',
      os_platform: 'darwin',
      apikey_id: null,
      org_id: null,
      source: 'config',
      api_version: '2025-10-01',
    })
    expect(backgroundTaskMock).not.toHaveBeenCalled()
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('writes Analytics Engine data point when CLI_USAGE is bound on workerd', async () => {
    vi.mocked(getRuntimeKey).mockReturnValue('workerd')
    const writeDataPoint = vi.fn()
    const c = createContext({ CLI_USAGE: { writeDataPoint } })

    trackCliUsage(c, {
      cli_version: '8.32.8',
      command: 'bundle upload',
      node_version: 'v22.0.0',
      os_platform: 'darwin',
      apikey_id: 'rbac-1',
      org_id: null,
      source: 'config',
      api_version: '2025-10-01',
    })

    expect(backgroundTaskMock).toHaveBeenCalledTimes(1)
    await backgroundTaskMock.mock.calls[0]?.[1]
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['8.32.8', 'bundle upload', 'v22.0.0', 'darwin', 'rbac-1', '', 'config', '2025-10-01'],
      indexes: ['rbac-1'],
    })
    expect(getPgClientMock).not.toHaveBeenCalled()
  })

  it('indexes anonymous when apikey_id is missing', async () => {
    vi.mocked(getRuntimeKey).mockReturnValue('workerd')
    const writeDataPoint = vi.fn()
    trackCliUsage(createContext({ CLI_USAGE: { writeDataPoint } }), {
      cli_version: '8.32.8',
      command: '',
      node_version: 'v22.0.0',
      os_platform: 'linux',
      apikey_id: null,
      org_id: null,
      source: 'config',
      api_version: '',
    })
    await backgroundTaskMock.mock.calls[0]?.[1]
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      indexes: ['anonymous'],
    }))
  })

  it('inserts into Postgres when not on workerd AE path', async () => {
    vi.mocked(getRuntimeKey).mockReturnValue('deno')
    queryMock.mockResolvedValue({ rows: [] })

    trackCliUsage(createContext({}), {
      cli_version: '8.32.8',
      command: 'init',
      node_version: 'v22.0.0',
      os_platform: 'linux',
      apikey_id: null,
      org_id: null,
      source: 'config',
      api_version: '2025-10-01',
    })

    expect(backgroundTaskMock).toHaveBeenCalledTimes(1)
    await backgroundTaskMock.mock.calls[0]?.[1]
    expect(getPgClientMock).toHaveBeenCalled()
    expect(queryMock).toHaveBeenCalled()
    const [sql, args] = queryMock.mock.calls[0] ?? []
    expect(String(sql)).toContain('api_version')
    expect(args).toEqual(['8.32.8', 'init', 'v22.0.0', 'linux', null, null, 'config', '2025-10-01'])
    expect(closeClientMock).toHaveBeenCalled()
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
