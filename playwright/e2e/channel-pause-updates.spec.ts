import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { getSupabaseClient, resetAndSeedAppData, resetAppData } from '../../tests/test-utils'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

test.describe('channel bundle actions (change, pause, revert)', () => {
  test('shows the actions next to the bundle and confirms before pausing or reverting', async ({ page }) => {
    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })
    await page.login('test@capgo.app', 'testtest')
    await page.goto('/app/com.demo.app/channel/1')
    await dismissSupportPrompt(page)

    const bundleRow = page.locator('[data-test="channel-bundle-row"]')
    await expect(bundleRow).toBeVisible({ timeout: 30000 })
    await expect(bundleRow.locator('[data-test="channel-change-bundle"]')).toHaveText('Change bundle')

    const pauseButton = bundleRow.locator('[data-test="channel-pause-toggle"]')
    await expect(pauseButton).toHaveText('Pause updates')
    await expect(pauseButton).toBeEnabled({ timeout: 60000 })
    await pauseButton.click()
    await expect(page.locator('h3').filter({ hasText: 'Pause updates on this channel?' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Devices keep the bundle they already run and nothing is rolled back.', { exact: false })).toBeVisible()
    // Cancel so the shared seed channel keeps serving for other specs.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('[data-test="channel-paused-banner"]')).toHaveCount(0)

    const revertButton = bundleRow.locator('[data-test="channel-revert-builtin"]')
    await expect(revertButton).toBeEnabled()
    await revertButton.click()
    await expect(page.locator('h3').filter({ hasText: 'Revert all devices to built-in?' })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(pauseButton).toHaveText('Pause updates')
  })

  test('shows promote first in the bundle actions on a non-default channel', async ({ page }) => {
    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })
    await page.login('test@capgo.app', 'testtest')
    await page.goto('/app/com.demo.app/channel/2')
    await dismissSupportPrompt(page)

    const bundleRow = page.locator('[data-test="channel-bundle-row"]')
    await expect(bundleRow).toBeVisible({ timeout: 30000 })
    const promote = bundleRow.locator('[data-test="promote-to-channel"]')
    await expect(promote).toBeVisible({ timeout: 60000 })
    await expect(bundleRow.locator('button').nth(1)).toHaveAttribute('data-test', 'promote-to-channel')
    await promote.click()
    await expect(page.locator('[data-test="promote-channel-targets"]')).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})

async function closeOptionalDialog(page: Page) {
  // Resume/revert may offer a push notification; it is optional for this flow.
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
  if (await cancel.isVisible().catch(() => false))
    await cancel.click()
}

test.describe('channel pause and revert are saved (isolated app)', () => {
  const appId = `com.pause.e2e.${randomUUID().slice(0, 8)}`

  test.beforeAll(async () => {
    await resetAndSeedAppData(appId)
  })

  test.afterAll(async () => {
    await resetAppData(appId)
  })

  test('pause, resume, revert with rollout, then reassign a bundle', async ({ page }) => {
    const supabase = getSupabaseClient()
    const { data: channelRow } = await supabase.from('channels').select('id').eq('app_id', appId).eq('name', 'beta').single().throwOnError()
    const { data: rolloutVersion } = await supabase.from('app_versions').select('id').eq('app_id', appId).eq('name', '1.360.0').single().throwOnError()
    // An active rollout must be cleared by the full revert.
    await supabase.from('channels').update({ rollout_version: rolloutVersion.id, rollout_enabled: true, rollout_percentage_bps: 1000 }).eq('id', channelRow.id).throwOnError()
    const readChannel = async () => (await supabase.from('channels').select('version, paused_at, rollout_version, rollout_enabled').eq('id', channelRow.id).single().throwOnError()).data

    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })
    await page.login('test@capgo.app', 'testtest')
    await page.goto(`/app/${appId}/channel/${channelRow.id}`)
    await dismissSupportPrompt(page)

    const bundleRow = page.locator('[data-test="channel-bundle-row"]')
    const pauseButton = bundleRow.locator('[data-test="channel-pause-toggle"]')
    const pausedBanner = page.locator('[data-test="channel-paused-banner"]')
    await expect(pauseButton).toBeEnabled({ timeout: 60000 })

    // Pause is saved and survives a reload.
    await pauseButton.click()
    await page.getByRole('button', { name: 'Pause updates', exact: true }).last().click()
    await expect(pausedBanner).toBeVisible({ timeout: 15000 })
    await page.reload()
    await expect(pausedBanner).toBeVisible({ timeout: 30000 })
    await expect(pauseButton).toHaveText('Resume updates')
    expect((await readChannel()).paused_at).not.toBeNull()

    // Resume clears the pause.
    await pauseButton.click()
    await page.getByRole('button', { name: 'Resume updates', exact: true }).last().click()
    await expect(pausedBanner).toHaveCount(0, { timeout: 15000 })
    await closeOptionalDialog(page)
    await expect.poll(async () => (await readChannel()).paused_at).toBeNull()

    // Revert sends devices to built-in and stops the rollout.
    await bundleRow.locator('[data-test="channel-revert-builtin"]').click()
    await expect(page.getByText('The progressive rollout to 1.360.0 is stopped as well.', { exact: false })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: 'Revert to built-in', exact: true }).last().click()
    await expect(bundleRow).toContainText('Built-in (native app)', { timeout: 15000 })
    await closeOptionalDialog(page)
    await page.reload()
    await expect(bundleRow).toContainText('Built-in (native app)', { timeout: 30000 })
    const reverted = await readChannel()
    expect(reverted.version).toBeNull()
    expect(reverted.rollout_version).toBeNull()
    expect(reverted.rollout_enabled).toBe(false)

    // Reassigning a bundle serves it again.
    await bundleRow.locator('[data-test="channel-change-bundle"]').click()
    await page.getByRole('button', { name: /^1\.361\.0/ }).click()
    await expect.poll(async () => (await readChannel()).version, { timeout: 15000 }).not.toBeNull()
    await closeOptionalDialog(page)
    await expect(bundleRow.getByRole('button', { name: '1.361.0', exact: true })).toBeVisible({ timeout: 15000 })
  })
})
