import type { Page, Route } from '@playwright/test'
import { expect, test } from '../support/commands'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

// The seeded demo app owned by the `test@capgo.app` user (see supabase/seed.sql).
// Sibling specs implicitly rely on this same login, so we reuse its demo app id.
const APP_ID = 'com.demo.app'

// A single unresolved, incompatible event used across the history + accept flows.
// `id` is the PostgREST primary key the accept RPC is called with; the bundle ids
// drive the dependency-diff deep link.
const EVENT_ID = 4242
const CURRENT_VERSION_ID = 5
const PREVIOUS_VERSION_ID = 3
const CURRENT_VERSION_NAME = '1.361.0'
const PREVIOUS_VERSION_NAME = '1.0.0'
const CHANNEL_NAME = 'production'
const OFFENDER = '@capacitor/camera'

function unresolvedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    app_id: APP_ID,
    source: 'default_channel_version_changed',
    platform: 'ios',
    channel_id: 1,
    channel_name: CHANNEL_NAME,
    current_version_id: CURRENT_VERSION_ID,
    current_version_name: CURRENT_VERSION_NAME,
    previous_version_id: PREVIOUS_VERSION_ID,
    previous_version_name: PREVIOUS_VERSION_NAME,
    offenders: [OFFENDER],
    created_at: '2026-06-03T10:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
    resolution_kind: null,
    resolution_note: null,
    ...overrides,
  }
}

/**
 * Mock both shapes of the `compatibility_events` read against the Supabase REST
 * endpoint:
 *  - The banner issues a HEAD request with `count=exact` and reads the row count
 *    from the `Content-Range` header (PostgREST contract), body is empty.
 *  - The history page issues a GET that returns the rows as a JSON array.
 *
 * `rows()` is read lazily on every request so a test can mutate the dataset
 * (e.g. mark the event resolved after the accept RPC) and have the next reload
 * observe the new state.
 */
async function mockCompatibilityEvents(page: Page, rows: () => Record<string, unknown>[]) {
  await page.route('**/rest/v1/compatibility_events*', async (route: Route) => {
    const data = rows()
    const method = route.request().method()

    if (method === 'HEAD') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Content-Range': `0-${Math.max(data.length - 1, 0)}/${data.length}`,
        },
        body: '',
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Content-Range': `0-${Math.max(data.length - 1, 0)}/${data.length}`,
      },
      body: JSON.stringify(data),
    })
  })
}

async function mockStoreReleaseValidationStatus(page: Page) {
  await page.route('**/rest/v1/app_versions*', async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.search.includes('name=neq.unknown') && url.search.includes('name=neq.builtin')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: CURRENT_VERSION_ID }]),
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/private/devices**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0 }),
    })
  })
}

test.describe('Compatibility events', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('shows the store release validation alert before opening the modal', async ({ page }) => {
    await mockCompatibilityEvents(page, () => [])

    await mockStoreReleaseValidationStatus(page)
    await page.goto(`/app/${APP_ID}`)

    const alert = page.locator('[data-test="store-release-validation-alert"]')
    const modal = page.getByRole('dialog')
    await expect(alert).toBeVisible()
    await expect(alert.getByText('Production release check')).toBeVisible()
    await expect(alert.getByText('Live Update bundle detected')).toBeVisible()
    await expect(modal).not.toBeVisible()

    await alert.locator('[data-test="store-release-validation-open"]').click()
    await expect(modal).toBeVisible()
    await expect(modal.getByText('Is this app published with Capgo in production?')).toBeVisible()

    await modal.getByRole('button', { name: 'Later' }).click()
    await expect(modal).not.toBeVisible()
    await expect(alert).toBeVisible()
    await page.waitForTimeout(1000)
    await expect(modal).not.toBeVisible()

    await alert.locator('[data-test="store-release-validation-dismiss"]').click()
    await expect(alert).not.toBeVisible()
    await page.reload()
    await expect(alert).toBeVisible()
    await alert.locator('[data-test="store-release-validation-open"]').click()
    await expect(modal).toBeVisible()
    await modal.getByRole('button', { name: 'Yes, app is published' }).click()

    await expect(modal.getByText('Validate the production setup')).toBeVisible()
    await expect(modal.getByLabel('Production channel')).toBeVisible()
    await modal.getByRole('button', { name: 'Apply setup' }).click()
    await expect(modal.getByText('Production channel setup applied.')).toBeVisible()

    await modal.getByText('Close', { exact: true }).click()
    await expect(modal).not.toBeVisible()
  })

  test('shows the unresolved banner on the app dashboard and links to the history page', async ({ page }) => {
    await mockCompatibilityEvents(page, () => [unresolvedEvent()])

    await page.goto(`/app/${APP_ID}`)

    const storeReleaseValidationAlert = page.locator('[data-test="store-release-validation-alert"]')
    await storeReleaseValidationAlert.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined)
    if (await storeReleaseValidationAlert.isVisible())
      await storeReleaseValidationAlert.locator('[data-test="store-release-validation-dismiss"]').click()
    // The banner exposes a stable data-test hook; keep the copy assertions for
    // content correctness but locate the CTA via its data-test attribute.
    const banner = page.locator('[data-test="compatibility-banner"]')
    await expect(banner).toBeVisible()
    await expect(banner.getByText('You have 1 unresolved compatibility event(s).')).toBeVisible()
    await expect(page.getByText('Compatibility events').first()).toBeVisible()

    await banner.locator('[data-test="compatibility-banner-view"]').click()
    await page.waitForURL(url => url.pathname === `/app/${APP_ID}/compatibility`)
  })

  test('renders an unresolved event row with its details and dependency-diff link', async ({ page }) => {
    await mockCompatibilityEvents(page, () => [unresolvedEvent()])

    await page.goto(`/app/${APP_ID}/compatibility`)

    await expect(page.getByRole('heading', { name: 'Compatibility events' })).toBeVisible()

    const row = page.locator(`[data-test="compatibility-row"][data-event-id="${EVENT_ID}"]`)
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('iOS')
    await expect(row).toContainText(CHANNEL_NAME)
    await expect(row).toContainText(CURRENT_VERSION_NAME)
    await expect(row).toContainText(PREVIOUS_VERSION_NAME)
    await expect(row).toContainText(OFFENDER)
    await expect(row).toContainText('Unresolved')

    // The dependency-diff link points at the existing bundle dependencies view,
    // comparing current vs previous bundle ids.
    await row.locator('[data-test="compatibility-diff-link"]').click()
    await page.waitForURL(url =>
      url.pathname === `/app/${APP_ID}/bundle/${CURRENT_VERSION_ID}/dependencies`
      && url.searchParams.get('compare') === String(PREVIOUS_VERSION_ID))
  })

  test('accepts an unresolved event after requiring a reason and calls the RPC', async ({ page }) => {
    // Mutable dataset: once the RPC resolves the event, the next reload (the page
    // re-reads after acknowledge) returns it as resolved, so the unresolved view
    // drops the row.
    let resolved = false
    await mockCompatibilityEvents(page, () => [
      resolved
        ? unresolvedEvent({
            resolved_at: '2026-06-03T11:00:00.000Z',
            resolved_by: 'test@capgo.app',
            resolution_kind: 'accepted',
            resolution_note: 'Intentional native release',
          })
        : unresolvedEvent(),
    ])

    let rpcBody: { event_id?: number, note?: string } | null = null
    await page.route('**/rest/v1/rpc/acknowledge_compatibility_event', async (route: Route) => {
      rpcBody = route.request().postDataJSON() as { event_id?: number, note?: string }
      resolved = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      })
    })

    await page.goto(`/app/${APP_ID}/compatibility`)

    // Filter to unresolved-only so the row disappearing is an observable assertion.
    await page.locator('[data-test="compatibility-filter-unresolved"]').check()

    const row = page.locator(`[data-test="compatibility-row"][data-event-id="${EVENT_ID}"]`)
    await expect(row).toHaveCount(1)

    // Open the accept dialog from the row action.
    await row.locator('[data-test="compatibility-accept"]').click()

    const dialog = page.locator('.fixed.inset-0.z-50')
    await expect(dialog.getByRole('heading', { name: 'Accept incompatibility' })).toBeVisible()
    const reason = dialog.locator('[data-test="compatibility-accept-reason"]')
    await expect(reason).toBeVisible()

    // The dialog confirm button is rendered by the shared DialogV2 component from
    // the store's `buttons` array, which has no data-test hook (adding one would
    // change the shared DialogV2Button store API). Scope a role selector to the
    // already-narrowed dialog container instead.
    const confirmButton = dialog.getByRole('button', { name: 'Accept', exact: true })

    // Submitting with an empty reason is rejected: the validation toast appears
    // and the dialog stays open (the handler returns false / preventClose).
    await confirmButton.click()
    await expect(page.locator('[data-test="toast"]'))
      .toContainText('Please provide a reason before accepting this incompatibility.')
    await expect(dialog.getByRole('heading', { name: 'Accept incompatibility' })).toBeVisible()
    expect(rpcBody).toBeNull()

    // Provide a reason and submit successfully.
    await reason.fill('Intentional native release')
    await confirmButton.click()

    // The RPC is called with the event id and the trimmed note.
    await expect.poll(() => rpcBody).not.toBeNull()
    expect(rpcBody).toMatchObject({
      event_id: EVENT_ID,
      note: 'Intentional native release',
    })

    // After resolution the row leaves the unresolved view.
    await expect(row).toHaveCount(0)
  })
})
