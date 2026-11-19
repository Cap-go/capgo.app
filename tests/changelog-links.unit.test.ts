// @vitest-environment happy-dom
import type { ChangelogProduct } from '../src/services/changelog'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import ChangelogUpdateBadge from '../src/components/changelog/ChangelogUpdateBadge.vue'
import PackageChangelogLink from '../src/components/changelog/PackageChangelogLink.vue'

const mocks = vi.hoisted(() => ({ latest: vi.fn() }))
vi.mock('../src/services/capgoApi', () => ({ invokeCapgoApi: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/services/changelog', async (original) => ({
  ...await original<typeof import('../src/services/changelog')>(),
  fetchLatestVersion: mocks.latest,
}))

let app: ReturnType<typeof createApp> | undefined
let container: HTMLDivElement

async function mount(render: () => ReturnType<typeof h>) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] })
  await router.push('/')
  app = createApp(defineComponent({ setup: () => render }))
  app.use(router)
  app.mount(container)
  await nextTick()
}

beforeEach(() => {
  container = document.createElement('div')
  mocks.latest.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  app?.unmount()
})

describe('upgrade entry points', () => {
  it('keeps CLI release notes linked when the latest-version lookup fails', async () => {
    await mount(() => h(ChangelogUpdateBadge, { product: 'cli', current: '8.0.0', showNotes: true }))
    await vi.waitFor(() => expect(container.querySelector('a')?.textContent).toContain('changelog-whats-new'))
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/changelog?product=cli&since=8.0.0')
  })

  it('does not let a slow response for the previous plugin replace the current version check', async () => {
    const stale = Promise.withResolvers<string | null>()
    mocks.latest.mockReturnValueOnce(stale.promise).mockResolvedValueOnce('2.0.0')
    const props = reactive<{ product: ChangelogProduct, current: string, repo: string, showNotes: boolean }>({ product: 'dependency', current: '1.0.0', repo: 'first-plugin', showNotes: true })
    await mount(() => h(ChangelogUpdateBadge, props))
    props.repo = 'second-plugin'
    await nextTick()
    await nextTick()
    stale.resolve('9.0.0')
    await nextTick()
    await nextTick()
    expect(container.querySelector('[data-test="changelog-update-badge"]')).not.toBeNull()
    expect(container.querySelector('a')?.getAttribute('href')).toContain('repo=second-plugin')
    expect(container.querySelector('a')?.getAttribute('href')).toContain('to=2.0.0')
    expect(mocks.latest).toHaveBeenLastCalledWith('dependency', 'second-plugin')
  })

  it.each([
    ['@capacitor/core', 'capacitor'],
    ['@capacitor/android', 'capacitor'],
    ['@capacitor/camera', 'dependency'],
    ['@capacitor-community/sqlite', 'dependency'],
    ['@capgo/capacitor-updater', 'updater'],
  ])('opens the exact dependency change for %s', async (name, product) => {
    await mount(() => h(PackageChangelogLink, { name, version: '8.2.0', fromVersion: '8.0.0' }))
    const href = container.querySelector('a')?.getAttribute('href') ?? ''
    const query = new URL(href, 'https://example.com').searchParams
    expect(query.get('product')).toBe(product)
    expect(query.get('since')).toBe('8.0.0')
    expect(query.get('to')).toBe('8.2.0')
    expect(mocks.latest).not.toHaveBeenCalled()
  })
})
