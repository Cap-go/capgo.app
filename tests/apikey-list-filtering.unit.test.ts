import { describe, expect, it } from 'vitest'
import { clearApiKeyScopeFilters, filterApiKeyListRows } from '../src/services/apikeys'

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

describe('API key list filtering', () => {
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
