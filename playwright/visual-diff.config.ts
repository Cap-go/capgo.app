import type { Page } from '@playwright/test'

export interface VisualDiffRoute {
  slug: string
  path: string
  /** When true, logs in as test@capgo.app before visiting the route. */
  auth?: boolean
  /** Optional deterministic UI setup before the screenshot is captured. */
  prepare?: (page: Page) => Promise<void>
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

const updaterInsightDays = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']

// Mix of updater failures and native signals. The mock honours the `actions`
// filter in the request, like the real endpoint does.
const updaterInsightActionRows: Array<[string, number, number, number]> = [
  ['webview_render_process_gone', 412, 301, 3],
  ['download_fail', 286, 204, 4],
  ['webview_javascript_error', 197, 88, 2],
  ['app_killed_low_memory', 38, 35, 2],
  ['update_fail', 24, 21, 2],
  ['unzip_fail', 17, 15, 2],
  ['insufficient_disk_space', 11, 9, 2],
  ['checksum_fail', 6, 5, 1],
  ['app_crash', 9, 7, 1],
]

async function mockUpdaterInsights(page: Page) {
  await page.route('**/private/stats/insights', async (route) => {
    const body = route.request().postDataJSON() as { actions?: string[] } | null
    const allowed = body?.actions?.length ? new Set(body.actions) : null
    const rows = updaterInsightActionRows.filter(([action]) => !allowed || allowed.has(action))
    const total = rows.reduce((sum, [, events]) => sum + events, 0)
    const devices = rows.reduce((sum, [, , deviceCount]) => sum + deviceCount, 0)
    const weights = [0.12, 0.13, 0.14, 0.18, 0.15, 0.14, 0.14]
    await route.fulfill({
      json: {
        summary: { total, device_count: devices, action_count: rows.length },
        actions: rows.map(([action, events, deviceCount, versionCount]) => ({
          action,
          total: events,
          device_count: deviceCount,
          version_count: versionCount,
          first_seen: '2026-09-24T08:12:00.000Z',
          last_seen: '2026-09-30T17:40:00.000Z',
          latest_version_name: '2.4.1',
          latest_device_id: '00000000-0000-4000-8000-000000000001',
        })),
        daily: rows.flatMap(([action, events]) => updaterInsightDays.map((date, index) => ({
          date,
          action,
          total: Math.round(events * weights[index]),
        }))),
        versions: rows.slice(0, 6).map(([action, events, deviceCount], index) => ({
          action,
          version_name: index % 2 ? '2.4.0' : '2.4.1',
          total: Math.round(events * 0.6),
          device_count: Math.round(deviceCount * 0.6),
          last_seen: '2026-09-30T17:40:00.000Z',
        })),
        devices: rows.slice(0, 5).map(([action, events], index) => ({
          action,
          device_id: `00000000-0000-4000-8000-00000000000${index + 1}`,
          total: Math.max(1, Math.round(events / 40)),
          version_name: '2.4.1',
          last_seen: '2026-09-30T17:40:00.000Z',
        })),
        period: {
          requested_days: 7,
          start: '2026-09-24T00:00:00.000Z',
          end: '2026-09-30T23:59:59.999Z',
          labels: updaterInsightDays,
        },
      },
    })
  })
}

// Shaped like a real production rollout: a normal trickle of download
// failures next to a healthy success rate.
const releaseLiveInstalls = [340, 550, 660, 630, 650, 660, 570, 560, 560, 530, 480, 520, 490, 740, 660, 610, 540, 500, 460, 460, 410, 390, 365, 360, 335, 365, 305, 305, 238, 245, 190, 170, 148, 146, 98, 98, 104, 88, 106, 110, 98, 164, 205, 270, 318, 318, 330, 375, 455, 475, 465, 520, 190]

async function mockReleaseLive(page: Page) {
  const bucketMs = 30 * 60_000
  const start = Date.parse('2026-10-01T13:30:00.000Z')
  const series = releaseLiveInstalls.map((install, index) => {
    const fail = Math.round(install * 0.03)
    return { ts: new Date(start + index * bucketMs).toISOString(), get: install + fail + 20, install, fail }
  })
  const install = series.reduce((sum, bucket) => sum + bucket.install, 0)
  const fail = series.reduce((sum, bucket) => sum + bucket.fail, 0)
  const get = series.reduce((sum, bucket) => sum + bucket.get, 0)
  const deployedAt = new Date(start).toISOString()
  const production = { id: 1, name: 'production', is_default: true }
  await page.route('**/private/release_live', route => route.fulfill({
    json: {
      release: { bundle_id: 1, version_name: '10.33.2', channel_id: 1, channel_name: 'production', deployed_at: deployedAt },
      window: { start: deployedAt, end: new Date(start + series.length * bucketMs).toISOString(), bucket_minutes: 30, truncated: false },
      totals: { get, install, fail, success_rate: Math.round((install / (install + fail)) * 1000) / 10 },
      adoption: { devices_on_release: 20001, total_devices: 189574, percent: 10.6 },
      failures: [
        { action: 'download_fail', count: Math.round(fail * 0.88) },
        { action: 'update_fail', count: fail - Math.round(fail * 0.88) },
      ],
      failed_devices: { total: 484, recovered: 15, stuck: 469 },
      series,
      channel: production,
      channels: [production, { id: 2, name: 'beta', is_default: false }],
      recent_deployments: [{ version_name: '10.33.2', channel_id: 1, channel_name: 'production', deployed_at: deployedAt }],
      generated_at: new Date().toISOString(),
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
      await page.route('**/rest/v1/user_security?*', route => route.fulfill({ json: { email_otp_verified_at: null } }))
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
  { slug: 'app-settings-usage', path: '/app/com.demo.app/settings/usage', auth: true },
  { slug: 'app-dashboard-native', path: '/app/com.demo.app/native', auth: true },
  { slug: 'app-dashboard-installs', path: '/app/com.demo.app/installs', auth: true },
  { slug: 'app-dashboard-active-bundle', path: '/app/com.demo.app/active-bundle', auth: true },
  {
    slug: 'app-dashboard-live-release',
    path: '/app/com.demo.app/live',
    auth: true,
    prepare: async (page) => {
      // Seed data has no recent rollout, so fixture the live release stats.
      await mockReleaseLive(page)
      await page.goto('/app/com.demo.app/live')
      await page.getByText('10.33.2', { exact: true }).waitFor()
    },
  },
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
    slug: 'observe-updater-failures',
    path: '/app/com.demo.app/observe/updater',
    auth: true,
    prepare: async (page) => {
      // Seed data has no updater failures, so fixture the insights to show the populated layout.
      await mockUpdaterInsights(page)
      await page.goto('/app/com.demo.app/observe/updater?days=7')
      await page.getByRole('heading', { name: /Error categories|Failure types/ }).waitFor()
    },
  },
  {
    slug: 'observe-updater-failures-details',
    path: '/app/com.demo.app/observe/updater',
    auth: true,
    prepare: async (page) => {
      await mockUpdaterInsights(page)
      await page.goto('/app/com.demo.app/observe/updater?days=7')
      const heading = page.getByRole('heading', { name: /Error categories|Failure types/ })
      await heading.waitFor()
      await heading.evaluate(el => el.scrollIntoView({ block: 'start' }))
    },
  },
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
      // Base renders "Action breakdown" as a heading, head as a detail tab.
      await page.getByRole('heading', { name: 'Action breakdown' }).or(page.getByRole('tab', { name: 'Action breakdown' })).first().waitFor()
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
      const tab = page.getByRole('tab', { name: 'Action breakdown' })
      await heading.or(tab).first().waitFor()
      // Head shows one detail table at a time behind tabs; base stacks them.
      if (await tab.isVisible())
        await tab.click()
      else
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
