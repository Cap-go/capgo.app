import type { Page } from '@playwright/test'

export interface VisualDiffRoute {
  slug: string
  path: string
  /** When true, logs in as test@capgo.app before visiting the route. */
  auth?: boolean
  /** Optional deterministic UI setup before the screenshot is captured. */
  prepare?: (page: Page) => Promise<void>
}

async function mockConsoleSecurity(page: Page) {
  await page.route('**/private/console/query', (route) => {
    const query = route.request().postDataJSON()
    if (query.kind !== 'table' || query.name !== 'user_security')
      return route.fallback()
    return route.fulfill({ json: { data: { email_otp_verified_at: null }, error: null, status: 200 } })
  })
}

const nativeObserveDays = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']

const nativeObserveActionRows: Array<[string, number, number, number | null, number | null, number | null, boolean]> = [
  ['app_launch_ready', 18420, 5120, 820, 1650, 3100, false],
  ['webview_page_loaded', 18110, 5080, 540, 1180, 2400, false],
  ['webview_render_process_gone', 412, 301, null, null, null, true],
  ['webview_content_process_terminated', 268, 190, null, null, null, true],
  ['webview_javascript_error', 197, 88, null, null, null, true],
  ['app_memory_warning', 143, 120, null, null, null, true],
  ['webview_resource_error', 61, 40, null, null, null, true],
  ['app_killed_low_memory', 38, 35, null, null, null, true],
  ['app_crash', 9, 7, null, null, null, true],
  ['app_launch_timeout', 4, 4, null, null, null, true],
]

async function mockNativeObserveStats(page: Page) {
  const emptySeries = nativeObserveDays.map(() => null)
  await page.route('**/private/update_delivery_stats', route => route.fulfill({
    json: {
      scope: 'app',
      labels: nativeObserveDays,
      period: { requested_days: 7, actual_days: 7, start: '2026-09-24T00:00:00.000Z', end: '2026-09-30T23:59:59.999Z' },
      overview: { samples: 0, devices: null, p50_ms: null, p75_ms: null, p95_ms: null, p99_ms: null },
      daily: { samples: nativeObserveDays.map(() => 0), p50_ms: emptySeries, p75_ms: emptySeries, p95_ms: emptySeries, p99_ms: emptySeries },
    },
  }))
  await page.route('**/private/native_observe_stats', route => route.fulfill({
    json: {
      labels: nativeObserveDays,
      period: { requested_days: 7, actual_days: 7, start: '2026-09-24T00:00:00.000Z', end: '2026-09-30T23:59:59.999Z' },
      overview: {
        total_events: 37662,
        total_devices: 5230,
        issue_count: 1132,
        affected_devices: 612,
        issue_free_rate: 88.3,
        launch_timeout_count: 4,
        launch_p50_ms: 820,
        launch_p90_ms: 1650,
        webview_load_p50_ms: 540,
        webview_load_p90_ms: 1180,
      },
      daily: {
        total_events: [5200, 5310, 5402, 5388, 5290, 5460, 5612],
        issue_events: [150, 162, 171, 158, 149, 166, 176],
        launches: [2540, 2600, 2650, 2630, 2590, 2680, 2730],
        webview_loads: [2500, 2570, 2610, 2590, 2560, 2620, 2660],
        launch_p50_ms: [810, 830, 820, 800, 815, 825, 840],
        launch_p90_ms: [1600, 1680, 1640, 1620, 1650, 1670, 1690],
        webview_load_p50_ms: [530, 540, 550, 535, 545, 540, 548],
        webview_load_p90_ms: [1150, 1190, 1170, 1160, 1185, 1180, 1200],
      },
      actionBreakdown: nativeObserveActionRows.map(([action, events, devices, p50, p90, p99, isIssue]) => ({
        action,
        events,
        devices,
        p50_ms: p50,
        p90_ms: p90,
        p99_ms: p99,
        is_issue: isIssue,
      })),
      version_group: 'version',
      versions: [
        { version_name: '2.4.1', platform: null, channel_name: null, events: 21400, devices: 3100, issue_count: 610, affected_devices: 340, issue_free_rate: 89, launch_p90_ms: 1620, webview_load_p90_ms: 1150 },
        { version_name: '2.4.0', platform: null, channel_name: null, events: 16262, devices: 2130, issue_count: 522, affected_devices: 272, issue_free_rate: 87.2, launch_p90_ms: 1690, webview_load_p90_ms: 1210 },
      ],
      releaseMarkers: [
        { version_name: '2.4.1', channel_name: 'production', deployed_at: '2026-09-27T10:00:00.000Z' },
      ],
    },
  }))
}

/**
 * Console pages captured for before/after visual diffs.
 * Add routes here when a PR touches a new screen reviewers should compare.
 */
export const visualDiffRoutes: VisualDiffRoute[] = [
  { slug: 'login', path: '/login/', auth: false },
  { slug: 'dashboard', path: '/dashboard', auth: true },
  { slug: 'account-settings', path: '/settings/account', auth: true },
  {
    slug: 'email-verification-send',
    path: '/resend_email',
    auth: true,
    prepare: async (page) => {
      await mockConsoleSecurity(page)
      await page.route('**/rest/v1/user_security?*', route => route.fulfill({ json: { email_otp_verified_at: null } }))
      await page.goto('/resend_email?reason=email_not_verified&return_to=/settings/account')
      await page.getByRole('button', { name: 'Send verification code', exact: true }).waitFor()
    },
  },
  {
    slug: 'email-verification-code',
    path: '/resend_email',
    auth: true,
    prepare: async (page) => {
      // Keep screenshots deterministic and never send a real verification email.
      await mockConsoleSecurity(page)
      await page.route('**/rest/v1/user_security?*', route => route.fulfill({ json: { email_otp_verified_at: null } }))
      await page.route('**/auth/email-otp/send-verification-otp', route => route.fulfill({ json: { success: true } }))
      await page.route('**/auth/v1/otp', route => route.fulfill({ json: { user: null, session: null } }))
      await page.goto('/resend_email?reason=email_not_verified&return_to=/settings/account')
      await page.getByRole('button', { name: 'Send verification code', exact: true }).click()
      await page.getByLabel('Enter the verification code', { exact: true }).waitFor()
    },
  },
  { slug: 'organization-credits', path: '/settings/organization/credits', auth: true },
  { slug: 'apps', path: '/apps', auth: true },
  {
    slug: 'apps-sidebar-collapsed',
    path: '/apps',
    auth: true,
    prepare: async (page) => {
      const toggle = page.locator('[data-test="sidebar-collapse-toggle"]')
      if (!(await toggle.count()))
        return
      const sidebar = page.locator('#sidebar')
      if (await sidebar.isVisible()) {
        await toggle.click()
        // Base may fully hide the sidebar (width 0). Head keeps a ~48px icon rail.
        await page.waitForFunction(() => {
          const el = document.querySelector('#sidebar')
          return !!el && el.getBoundingClientRect().width < 56
        })
      }
    },
  },
  { slug: 'app-overview', path: '/app/com.demo.app', auth: true },
  { slug: 'app-dashboard-native', path: '/app/com.demo.app/native', auth: true },
  { slug: 'app-dashboard-installs', path: '/app/com.demo.app/installs', auth: true },
  { slug: 'app-dashboard-active-bundle', path: '/app/com.demo.app/active-bundle', auth: true },
  {
    slug: 'onboarding-setup-v3',
    path: '/apps',
    auth: true,
    prepare: async (page) => {
      // Read-only response fixtures let both base and head render the same app.
      // The base ignores version 3; the head shows the experiment treatment.
      const onboarding = { setup: { todo_list_version: 3, source: 'manual', outcome: 'in_progress', steps: {} } }
      await page.route('**/rest/v1/apps?*', async (route) => {
        const response = await route.fetch()
        const json = await response.json().catch(() => null)
        const override = (row: any) => row?.app_id === 'com.demo.app' ? { ...row, need_onboarding: true, onboarding } : row
        await route.fulfill({ response, json: Array.isArray(json) ? json.map(override) : override(json) })
      })
      await page.route('**/private/console/query', async (route) => {
        const query = route.request().postDataJSON()
        if (query.kind === 'rpc' && query.name === 'verify_getting_started')
          return route.fulfill({ json: { data: onboarding, error: null, status: 200 } })
        if (query.kind !== 'table' || query.name !== 'apps')
          return route.fallback()
        const response = await route.fetch()
        const json = await response.json()
        const override = (row: any) => row?.app_id === 'com.demo.app' ? { ...row, need_onboarding: true, onboarding } : row
        await route.fulfill({ response, json: { ...json, data: Array.isArray(json.data) ? json.data.map(override) : override(json.data) } })
      })
      await page.route('**/rpc/verify_getting_started', route => route.fulfill({ json: onboarding }))
      await page.route('**/private/onboarding_progress', route => route.fulfill({ json: { onboarding, hasChannel: false, checkErrors: [] } }))
      await page.goto('/app/com.demo.app/getting-started')
      await page.getByRole('heading', { name: /Start guided setup|Finish setup in your app/ }).waitFor()
    },
  },
  { slug: 'app-getting-started', path: '/app/com.demo.app/getting-started', auth: true },
  { slug: 'app-settings', path: '/app/com.demo.app/settings', auth: true },
  { slug: 'app-settings-access', path: '/app/com.demo.app/settings/access', auth: true },
  { slug: 'org-settings', path: '/settings/organization', auth: true },
  { slug: 'org-settings-team', path: '/settings/organization/members', auth: true },
  { slug: 'org-settings-billing', path: '/settings/organization/plans', auth: true },
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
      // Head has OS range filters; base from #2792 only has platform/bundle.
      const osFilter = page.locator('[data-test="device-os-version-filter"]')
      try {
        await osFilter.waitFor({ state: 'visible', timeout: 3000 })
      }
      catch {
        // Keep the platform/bundle modal screenshot on older bases.
      }
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
  {
    slug: 'observe-native',
    path: '/app/com.demo.app/observe/native',
    auth: true,
    prepare: async (page) => {
      // Seed data has no native observe events, so fixture the stats to show the populated layout.
      await mockNativeObserveStats(page)
      await page.goto('/app/com.demo.app/observe/native')
      await page.getByRole('heading', { name: 'Action breakdown' }).waitFor()
    },
  },
  {
    slug: 'observe-native-actions',
    path: '/app/com.demo.app/observe/native',
    auth: true,
    prepare: async (page) => {
      await mockNativeObserveStats(page)
      await page.goto('/app/com.demo.app/observe/native')
      const heading = page.getByRole('heading', { name: 'Action breakdown' })
      await heading.waitFor()
      await heading.evaluate(el => el.scrollIntoView({ block: 'start' }))
    },
  },
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
      const createKey = page.locator('[data-test="create-key"]')
      await createKey.waitFor({ state: 'visible', timeout: 30_000 })
      await createKey.click()
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
