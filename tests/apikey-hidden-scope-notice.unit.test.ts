// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises'
import { cwd } from 'node:process'
import type { App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../messages/en.json'
import ApiKeyHiddenScopeNotice from '../src/components/ApiKeyHiddenScopeNotice.vue'

const mountedApps: App[] = []
const repoRoot = cwd()

async function readRepoFile(path: string) {
  return readFile(`${repoRoot}/${path}`, 'utf8')
}

function mountNotice(hiddenCount: number, isLoading = false) {
  const container = document.createElement('div')
  const removeFilter = vi.fn()
  const app = createApp(ApiKeyHiddenScopeNotice, {
    hiddenCount,
    isLoading,
    onRemoveFilter: removeFilter,
  })

  app.use(createI18n({
    legacy: false,
    locale: 'en',
    messages: { en },
  }))
  app.mount(container)
  mountedApps.push(app)

  return { container, removeFilter }
}

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
})

describe('API key hidden-scope notice', () => {
  it('stays hidden when no matching keys are excluded or while keys are loading', () => {
    expect(mountNotice(0).container.querySelector('[role="status"]')).toBeNull()
    expect(mountNotice(3, true).container.querySelector('[role="status"]')).toBeNull()
  })

  it('renders the plural translated status and emits the remove-filter action', () => {
    const { container, removeFilter } = mountNotice(3)
    const status = container.querySelector('[role="status"]')
    const button = container.querySelector('button')

    expect(status?.querySelector('span')?.textContent?.trim()).toBe(
      '3 API keys are hidden by the current scope filter.',
    )
    expect(button?.textContent?.trim()).toBe('Remove the filter')
    expect(button?.classList.contains('d-btn')).toBe(true)
    expect(button?.classList.contains('d-btn-link')).toBe(true)

    button?.click()

    expect(removeFilter).toHaveBeenCalledOnce()
  })

  it('renders the singular translated status', () => {
    const { container } = mountNotice(1)

    expect(container.querySelector('[role="status"] span')?.textContent?.trim()).toBe(
      '1 API key is hidden by the current scope filter.',
    )
  })

  it('keeps the notice slot between the DataTable toolbar and table', async () => {
    const source = await readRepoFile('src/components/DataTable.vue')
    const toolbarIndex = source.indexOf('<div class="flex flex-wrap items-center justify-between')
    const noticeSlotIndex = source.indexOf('<slot name="table-notice" />')
    const tableIndex = source.indexOf('<table id="custom_table"')

    expect(toolbarIndex).toBeGreaterThan(-1)
    expect(noticeSlotIndex).toBeGreaterThan(toolbarIndex)
    expect(tableIndex).toBeGreaterThan(noticeSlotIndex)
  })

  it('keeps the ApiKeys page notice wired to the scope-clearing action', async () => {
    const source = await readRepoFile('src/pages/ApiKeys.vue')

    expect(source).toMatch(/<ApiKeyHiddenScopeNotice[\s\S]*?:hidden-count="hiddenByScopeCount"[\s\S]*?@remove-filter="clearScopeFilters\(\)"/)
  })
})
