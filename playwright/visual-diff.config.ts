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
  { slug: 'app-settings', path: '/app/com.demo.app/settings', auth: true },
  { slug: 'app-settings-access', path: '/app/com.demo.app/settings/access', auth: true },
  { slug: 'channels', path: '/app/com.demo.app/channels', auth: true },
  {
    slug: 'devices',
    path: '/app/com.demo.app/devices',
    auth: true,
    prepare: async (page) => {
      // Open Filters so reviewers see platform/bundle controls on head.
      // Base still uses the legacy dropdown, so fall back only when modal is absent.
      await page.getByRole('button', { name: /filters/i }).click()
      const modal = page.locator('[data-test="data-table-filters-modal"]')
      try {
        await modal.waitFor({ state: 'visible', timeout: 3000 })
      }
      catch {
        await page.getByText('Override', { exact: true }).waitFor({ state: 'visible' })
        return
      }
      await page.locator('[data-test="device-platform-filter"]').waitFor({ state: 'visible' })
    },
  },
  { slug: 'observe', path: '/app/com.demo.app/observe/updater', auth: true },
  {
    slug: 'observe-logs',
    path: '/app/com.demo.app/observe/logs',
    auth: true,
    prepare: async (page) => {
      // Open Actions so reviewers see the filter modal on head.
      // Base still uses the legacy dropdown, so fall back when modal is absent.
      const openButton = page.locator('[data-test="log-table-filters-open"]')
      if (await openButton.count()) {
        await openButton.click()
        await page.locator('[data-test="log-table-filters-modal"]').waitFor({ state: 'visible' })
        return
      }
      await page.getByRole('button', { name: /actions/i }).click()
      await page.getByText('All failures', { exact: true }).waitFor({ state: 'visible' })
    },
  },
  { slug: 'observe-native', path: '/app/com.demo.app/observe/native', auth: true },
  { slug: 'observe-compatibility', path: '/app/com.demo.app/observe/compatibility', auth: true },
  { slug: 'observe-plugins', path: '/app/com.demo.app/observe/plugins', auth: true },
  {
    slug: 'channel-statistics',
    path: '/app/com.demo.app/channel/1/statistics',
    auth: true,
  },
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
