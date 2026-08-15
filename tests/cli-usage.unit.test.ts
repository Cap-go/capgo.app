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
import { runQueryToCFA } from '../supabase/functions/_backend/utils/cloudflare.ts'
import { aggregateTopUsersByEmail, getAdminCliUsage, resolveCliUsageIdentity, trackCliUsage } from '../supabase/functions/_backend/utils/cli_usage.ts'

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

describe('aggregateTopUsersByEmail', () => {
  it('sums counts for the same email and keeps the top users', () => {
    expect(aggregateTopUsersByEmail([
      { email: 'alice@capgo.app', count: 10 },
      { email: 'bob@capgo.app', count: 7 },
      { email: 'alice@capgo.app', count: 5 },
      { email: '  ', count: 3 },
    ])).toEqual([
      { email: 'alice@capgo.app', count: 15 },
      { email: 'bob@capgo.app', count: 7 },
      { email: 'unknown', count: 3 },
    ])
  })
})

describe('getAdminCliUsage', () => {
  beforeEach(() => {
    cloudlogErrMock.mockReset()
    getPgClientMock.mockReset()
    closeClientMock.mockReset()
    queryMock.mockReset()
    getPgClientMock.mockReturnValue({ query: queryMock })
    closeClientMock.mockResolvedValue(undefined)
    vi.mocked(getRuntimeKey).mockReset()
    vi.mocked(runQueryToCFA).mockReset()
  })

  it('maps Analytics Engine API keys to user emails and aggregates by user', async () => {
    vi.mocked(getRuntimeKey).mockReturnValue('workerd')
    vi.mocked(runQueryToCFA).mockImplementation(async (_c, sql) => {
      if (String(sql).includes('index1 AS apikey_id')) {
        return [
          { apikey_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', count: 10 },
          { apikey_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', count: 5 },
          { apikey_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', count: 4 },
        ]
      }
      if (String(sql).includes('AS total'))
        return [{ total: 19 }]
      return []
    })
    queryMock.mockResolvedValue({
      rows: [
        { rbac_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'alice@capgo.app' },
        { rbac_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'alice@capgo.app' },
        { rbac_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'bob@capgo.app' },
      ],
    })

    const result = await getAdminCliUsage(
      createContext({ CLI_USAGE: {} }),
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    )

    expect(result.top_users).toEqual([
      { email: 'alice@capgo.app', count: 15 },
      { email: 'bob@capgo.app', count: 4 },
    ])
    expect(queryMock).toHaveBeenCalled()
    const [sql, args] = queryMock.mock.calls[0] ?? []
    expect(String(sql)).toContain('public.users')
    expect(args?.[0]).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ])
  })

  it('joins Postgres CLI usage to user emails', async () => {
    vi.mocked(getRuntimeKey).mockReturnValue('deno')
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('u.email')) {
        return { rows: [{ email: 'bob@capgo.app', count: '42' }] }
      }
      if (String(sql).includes('count(*)::bigint AS total'))
        return { rows: [{ total: '42' }] }
      return { rows: [] }
    })

    const result = await getAdminCliUsage(
      createContext({}),
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    )

    expect(result.top_users).toEqual([{ email: 'bob@capgo.app', count: 42 }])
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('LEFT JOIN public.apikeys'))).toBe(true)
  })
})
