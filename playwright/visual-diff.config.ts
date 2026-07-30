import type { Page } from '@playwright/test'

export interface VisualDiffRoute {
  slug: string
  path: string
  /** When true, logs in as test@capgo.app before visiting the route. */
  auth?: boolean
  /** Optional deterministic UI setup before the screenshot is captured. */
  prepare?: (page: Page) => Promise<void>
}

/**
 * Console pages captured for before/after visual diffs.
 * Add routes here when a PR touches a new screen reviewers should compare.
 */
export const visualDiffRoutes: VisualDiffRoute[] = [
  { slug: 'login', path: '/login/', auth: false },
  { slug: 'dashboard', path: '/dashboard', auth: true },
  { slug: 'apps', path: '/apps', auth: true },
  { slug: 'app-overview', path: '/app/com.demo.app', auth: true },
  { slug: 'channels', path: '/app/com.demo.app/channels', auth: true },
  {
    slug: 'devices',
    path: '/app/com.demo.app/devices',
    auth: true,
    prepare: async (page) => {
      // Open Filters modal so reviewers see platform/bundle controls.
      await page.getByRole('button', { name: /filters/i }).click()
      const modal = page.locator('[data-test="data-table-filters-modal"]')
      if (await modal.count())
        await modal.waitFor({ state: 'visible' })
      const platformFilter = page.locator('[data-test="device-platform-filter"]')
      if (await platformFilter.count())
        await platformFilter.waitFor({ state: 'visible' })
      else
        await page.getByText('Override', { exact: true }).waitFor({ state: 'visible' })
    },
  },
  { slug: 'observe', path: '/app/com.demo.app/observe', auth: true },
  { slug: 'observe-plugins', path: '/app/com.demo.app/observe/plugins', auth: true },
  {
    slug: 'api-keys-app-preview',
    path: '/apikeys',
    auth: true,
    prepare: async (page) => {
      await page.locator('[data-test="create-key"]').click()
      const appOnlyScope = page.locator('[data-test="create-key-app-only-scope"]')
      if (await appOnlyScope.count())
        await appOnlyScope.check()
    },
  },
]

export const visualDiffViewport = {
  width: 1280,
  height: 720,
} as const
