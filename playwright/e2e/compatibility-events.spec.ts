import type { Page, Route } from '@playwright/test'
import { expect, test } from '../support/commands'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

// The seeded demo app owned by the `test@capgo.app` user (see supabase/seed.sql).
// Sibling specs implicitly rely on this same login, so we reuse its demo app id.
const APP_ID = 'com.demo.app'
const TEST_USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'

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

// Read lazily so accepting an event updates the next console query.
async function mockCompatibilityEvents(page: Page, rows: () => Record<string, unknown>[]) {
  await page.route('**/private/console/query', async (route: Route) => {
    const query = route.request().postDataJSON()
    if (query.kind !== 'table' || query.name !== 'compatibility_events')
      return route.fallback()
    const data = rows()
    const head = query.operations.some((op: { method: string, args: any[] }) => op.method === 'select' && op.args[1]?.head)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: head ? null : data, count: data.length, error: null, status: 200 }),
    })
  })
}

test.describe('Compatibility events', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
    // Keep the support-usernames prompt from covering store-release alert actions.
    await page.evaluate((userId) => {
      localStorage.setItem(`capgo.supportUsernames.dismissed.${userId}`, '1')
    }, TEST_USER_ID)
  })

  test('shows the unresolved banner on the app dashboard and links to the history page', async ({ page }) => {
    await mockCompatibilityEvents(page, () => [unresolvedEvent()])

    await page.goto(`/app/${APP_ID}`)
    // Dashboard banners live behind the Activity menu.
    await page.locator('[data-testid="alerts-menu-toggle"]').click()
    // The banner exposes a stable data-test hook; keep the copy assertions for
    // content correctness but locate the CTA via its data-test attribute.
    const banner = page.locator('[data-test="compatibility-banner"]')
    await expect(banner).toBeVisible()
    await expect(banner.getByText('You have 1 unresolved compatibility event(s).')).toBeVisible()
    await expect(page.getByText('Compatibility events').first()).toBeVisible()

    await banner.locator('[data-test="compatibility-banner-view"]').click()
    await page.waitForURL(url => url.pathname === `/app/${APP_ID}/observe/compatibility`)
  })

  test('renders an unresolved event row with its details and dependency-diff link', async ({ page }) => {
    await mockCompatibilityEvents(page, () => [unresolvedEvent()])

    await page.goto(`/app/${APP_ID}/observe/compatibility`)

    await expect(page.getByRole('button', { name: 'Compatibility events', exact: true })).toHaveAttribute('aria-current', 'page')

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
    await page.route('**/private/console/query', async (route: Route) => {
      const query = route.request().postDataJSON()
      if (query.kind !== 'rpc' || query.name !== 'acknowledge_compatibility_event')
        return route.fallback()
      rpcBody = query.args[0] as { event_id?: number, note?: string }
      resolved = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: {}, error: null, count: null, status: 200 }),
      })
    })

    await page.goto(`/app/${APP_ID}/observe/compatibility`)

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

    // The reason is required: with the field empty the confirm button is disabled
    // (so it can no longer be dead-clicked), and no RPC fires.
    await expect(confirmButton).toBeDisabled()
    expect(rpcBody).toBeNull()

    // Typing a reason enables the button and submits successfully.
    await reason.fill('Intentional native release')
    await expect(confirmButton).toBeEnabled()
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
