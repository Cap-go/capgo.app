import type { ConsoleClient } from '../src/services/consoleClient'
import type { Database } from '../src/types/database.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearApiKeyScopeFilters, filterApiKeyListRows, findUsablePlainApiKey } from '../src/services/apikeys'

const mocks = vi.hoisted(() => ({
  invokeCapgoApi: vi.fn(),
}))

vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: mocks.invokeCapgoApi,
}))

interface ApiKeyInvokePayload {
  body: {
    bindings: Array<{
      role_name: string
      scope_type: 'org' | 'app'
      org_id: string
      app_id?: string
    }>
    global_permissions?: string[]
  }
}

function createSupabaseMock() {
  return {
    capgo: {} as unknown as ConsoleClient<Database>,
  }
}

describe('createAiApiKey', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.invokeCapgoApi.mockResolvedValue({ data: {}, error: null })
  })

  it('creates a member key with only the selected app bindings', async () => {
    const { createAiApiKey } = await import('../src/services/apikeys')
    const { capgo } = createSupabaseMock()

    await createAiApiKey(capgo, 'Preview key', {
      orgIds: ['org-a', 'org-b'],
      role: 'member',
      apps: [
        { uuid: 'app-a', orgId: 'org-a', role: 'app_preview' },
        { uuid: 'app-b', orgId: 'org-b', role: 'app_reader' },
      ],
    })

    const payload = mocks.invokeCapgoApi.mock.calls[0]?.[1] as ApiKeyInvokePayload
    expect(mocks.invokeCapgoApi).toHaveBeenCalledWith('apikey', expect.objectContaining({ method: 'POST', client: capgo }))
    expect(payload.body.bindings).toEqual([
      { role_name: 'app_preview', scope_type: 'app', org_id: 'org-a', app_id: 'app-a' },
      { role_name: 'app_reader', scope_type: 'app', org_id: 'org-b', app_id: 'app-b' },
    ])
    expect(payload.body.bindings.some(binding => binding.role_name === 'org_member')).toBe(false)
    expect(payload.body.global_permissions).toBeUndefined()
  })

  it('requires a member key to select at least one app', async () => {
    const { createAiApiKey } = await import('../src/services/apikeys')
    const { capgo } = createSupabaseMock()

    await expect(createAiApiKey(capgo, 'Empty member key', {
      orgIds: ['org-a'],
      role: 'member',
      apps: [],
    })).rejects.toThrow('Select at least one app for a member API key')
  })
})

interface Row {
  id: number
  orgIds: string[]
  appIds: string[]
  searchableValues: string[]
}

const rows: Row[] = [
  { id: 1, orgIds: ['org-a'], appIds: ['app-a'], searchableValues: ['Alpha key'] },
  { id: 2, orgIds: ['org-b'], appIds: ['app-b'], searchableValues: ['Beta key'] },
  { id: 3, orgIds: ['org-b'], appIds: ['app-c'], searchableValues: ['Alpha release'] },
]

const accessors = {
  getOrgIds: (row: Row) => row.orgIds,
  getAppIds: (row: Row) => row.appIds,
  getSearchableValues: (row: Row) => row.searchableValues,
}

function filterRows(options: Pick<Parameters<typeof filterApiKeyListRows<Row>>[1], 'appFilterIds' | 'orgFilterIds' | 'searchQuery'>) {
  return filterApiKeyListRows(rows, {
    ...options,
    ...accessors,
  })
}

describe('aPI key list filtering', () => {
  it.concurrent('counts keys excluded by an organization scope', () => {
    const result = filterRows({
      searchQuery: '',
      orgFilterIds: ['org-a'],
      appFilterIds: [],
    })

    expect(result.rows.map(row => row.id)).toEqual([1])
    expect(result.hiddenByScopeCount).toBe(2)
  })

  it.concurrent('counts only searchable keys as hidden by scope', () => {
    const result = filterRows({
      searchQuery: 'alpha',
      orgFilterIds: ['org-a'],
      appFilterIds: [],
    })

    expect(result.rows.map(row => row.id)).toEqual([1])
    expect(result.hiddenByScopeCount).toBe(1)
  })

  it.concurrent('reports zero when the active scopes include every searchable key', () => {
    const result = filterRows({
      searchQuery: 'alpha',
      orgFilterIds: ['org-a', 'org-b'],
      appFilterIds: [],
    })

    expect(result.rows.map(row => row.id)).toEqual([1, 3])
    expect(result.hiddenByScopeCount).toBe(0)
  })

  it.concurrent('reports zero when no scope filter is active', () => {
    const result = filterRows({
      searchQuery: '',
      orgFilterIds: [],
      appFilterIds: [],
    })

    expect(result.rows.map(row => row.id)).toEqual([1, 2, 3])
    expect(result.hiddenByScopeCount).toBe(0)
  })

  it.concurrent('combines organization and app scopes across groups', () => {
    const result = filterRows({
      searchQuery: '',
      orgFilterIds: ['org-b'],
      appFilterIds: ['app-b'],
    })

    expect(result.rows.map(row => row.id)).toEqual([2])
    expect(result.hiddenByScopeCount).toBe(2)
  })

  it.concurrent('clears every scope selection without changing the filter keys', () => {
    expect(clearApiKeyScopeFilters({
      'org:org-a': true,
      'app:app-a': true,
    })).toEqual({
      'org:org-a': false,
      'app:app-a': false,
    })
  })
})

// Minimal chainable console client: every query on a table resolves to its fixed rows.
function fakeClient(rows: Record<string, unknown>) {
  return {
    from: (table: string) => {
      const result = { data: rows[table], error: null }
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'not', 'in', 'order'])
        builder[method] = () => builder
      builder.single = async () => result
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return builder
    },
  } as unknown as ConsoleClient<Database>
}

describe('findUsablePlainApiKey app roles', () => {
  const rows = (role: string) => ({
    apikeys: [{ key: 'reader-key', expires_at: null, rbac_id: 'rbac-1', created_at: '2026-10-01' }],
    apps: { id: 'app-uuid', owner_org: 'org-1' },
    role_bindings: [{ principal_id: 'rbac-1', scope_type: 'app', app_id: 'app-uuid', roles: { name: role } }],
  })

  it.concurrent('reuses any app binding when no roles are required', async () => {
    expect(await findUsablePlainApiKey(fakeClient(rows('app_reader')), 'user-1', 'org-1', 'com.acme.app')).toBe('reader-key')
  })

  it.concurrent('skips an app key whose role cannot do the task', async () => {
    const client = fakeClient(rows('app_reader'))
    expect(await findUsablePlainApiKey(client, 'user-1', 'org-1', 'com.acme.app', { appRoles: ['app_admin'] })).toBeNull()
    expect(await findUsablePlainApiKey(fakeClient(rows('app_admin')), 'user-1', 'org-1', 'com.acme.app', { appRoles: ['app_admin'] })).toBe('reader-key')
  })
})
