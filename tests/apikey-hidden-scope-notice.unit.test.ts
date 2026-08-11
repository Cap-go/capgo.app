import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

async function readRepoFile(path: string) {
  return readFile(`${repoRoot}${path}`, 'utf8')
}

describe('API key hidden-scope notice', () => {
  it.concurrent('places the optional notice between the table toolbar and rows', async () => {
    const dataTableSource = await readRepoFile('src/components/DataTable.vue')
    const noticeSlotIndex = dataTableSource.indexOf('<slot name="table-notice" />')
    const tableWrapperIndex = dataTableSource.indexOf('<div class="block">')

    expect(noticeSlotIndex).toBeGreaterThan(-1)
    expect(tableWrapperIndex).toBeGreaterThan(noticeSlotIndex)
  })

  it.concurrent('renders a search-aware status with a scope-clearing action', async () => {
    const apiKeysSource = await readRepoFile('src/pages/ApiKeys.vue')

    expect(apiKeysSource).toContain('<template #table-notice>')
    expect(apiKeysSource).toContain('v-if="!isLoading && hiddenByScopeCount > 0"')
    expect(apiKeysSource).toContain('role="status"')
    expect(apiKeysSource).toContain('@click="clearScopeFilters()"')
    expect(apiKeysSource).toContain("t('api-key-hidden-by-scope-filter-one')")
    expect(apiKeysSource).toContain("t('api-keys-hidden-by-scope-filter-many', { count: hiddenByScopeCount })")
  })

  it.concurrent('provides the approved English copy', async () => {
    const messages = JSON.parse(await readRepoFile('messages/en.json')) as Record<string, string>

    expect(messages['api-key-hidden-by-scope-filter-one']).toBe('1 API key is hidden by the current scope filter.')
    expect(messages['api-keys-hidden-by-scope-filter-many']).toBe('{count} API keys are hidden by the current scope filter.')
    expect(messages['remove-api-key-scope-filter']).toBe('Remove the filter')
  })
})
