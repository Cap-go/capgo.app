// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import BundleCompareSelect from '../src/components/bundle/BundleCompareSelect.vue'

vi.mock('~/services/console', async () => {
  const { createConsoleClient } = await import('../src/services/consoleClient')
  return { useConsole: () => createConsoleClient({ persistSession: false }) }
})

const fetchMock = vi.fn()
let app: App | undefined
let container: HTMLDivElement

function response(data: unknown[] = [], error: { message: string } | null = null) {
  return Response.json({ data: error ? null : data, error, count: null, status: error ? 500 : 200 })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('VITE_API_HOST', 'https://api.example.com')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset().mockImplementation(async () => response())
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  app?.unmount()
  app = undefined
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function mount(compareMode: 'manifest' | 'dependencies' = 'manifest', onSelect = vi.fn()) {
  app = createApp(BundleCompareSelect, {
    appId: 'com.example.compare',
    currentVersionId: 100,
    compareMode,
    label: 'Compare with bundle',
    noneLabel: 'No comparison',
    latestLabel: 'Latest bundles',
    resultsLabel: 'Search results',
    searchPlaceholder: 'Search by name or bundle ID',
    noResultsLabel: 'No matching bundle',
    'onUpdate:modelValue': onSelect,
  })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.component('Spinner', { template: '<span />' })
  app.mount(container)
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0)
  await nextTick()
}

async function search(term: string) {
  const input = container.querySelector('input')!
  input.value = term
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  await vi.advanceTimersByTimeAsync(400)
  await nextTick()
}

describe('bundle comparison empty state', () => {
  it.each(['manifest', 'dependencies'] as const)('explains the absence of eligible %s bundles without a search term', async (mode) => {
    mount(mode)
    await settle()

    expect(container.querySelector('[role="status"]')?.textContent).toContain(messages[`bundle-compare-empty-${mode}`])
    expect(container.textContent).toContain('No comparison')
    expect(container.textContent).not.toContain('No matching bundle')
  })

  it('waits for pending bundle queries before showing an empty state', async () => {
    let resolveBundles!: (value: Response) => void
    fetchMock.mockImplementation(async (_url, init) => {
      if (JSON.parse(init.body).name === 'app_versions')
        return new Promise<Response>((resolve) => { resolveBundles = resolve })
      return response()
    })
    mount()
    await settle()
    expect(container.textContent).toContain(messages.loading)
    expect(container.querySelector('[role="status"]')).toBeNull()

    resolveBundles(response())
    await settle()
    expect(container.textContent).toContain(messages['bundle-compare-empty-manifest'])
  })

  it('distinguishes an unsuccessful search from having no comparison bundles', async () => {
    mount()
    await settle()
    await search('missing-bundle')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('No matching bundle')
    expect(container.textContent).not.toContain(messages['bundle-compare-empty-manifest'])

    await search('   ')
    expect(container.textContent).toContain(messages['bundle-compare-empty-manifest'])
  })

  it('shows a load failure instead of claiming that no bundles exist', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockImplementation(async (_url, init) => JSON.parse(init.body).name === 'app_versions'
      ? response([], { message: 'Query failed' })
      : response())
    mount()
    await settle()
    expect(container.querySelector('[role="status"]')?.textContent).toContain(messages['bundle-compare-load-error'])
    expect(container.textContent).not.toContain(messages['bundle-compare-empty-manifest'])

    await search('1.0')
    expect(container.querySelector('[role="status"]')?.textContent).toContain(messages['bundle-compare-load-error'])
    expect(container.textContent).not.toContain('No matching bundle')
  })

  it('keeps available bundles selectable', async () => {
    const bundle = { id: 99, name: '1.0.0', created_at: null, manifest_count: 2, app_id: 'com.example.compare' }
    fetchMock.mockImplementation(async (_url, init) => response(JSON.parse(init.body).name === 'app_versions' ? [bundle] : []))
    const onSelect = vi.fn()
    mount('manifest', onSelect)
    await settle()

    expect(container.querySelector('[role="status"]')).toBeNull()
    const option = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(bundle.name))!
    option.click()
    expect(onSelect).toHaveBeenCalledWith(bundle)
  })
})
