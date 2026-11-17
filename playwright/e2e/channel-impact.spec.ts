import { randomUUID } from 'node:crypto'
import { executeSQL, resetAndSeedAppData, resetAppData } from '../../tests/test-utils'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

// Devices on old and new store builds, so the preview has to explain why a
// major bump only reaches devices that installed the new store build.
test.describe('channel change impact preview (isolated app)', () => {
  const appId = `com.impact.e2e.${randomUUID().slice(0, 8)}`
  let channelId = 0

  async function insertBundle(name: string) {
    const [row] = await executeSQL<{ id: number }>(
      `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, r2_path, storage_provider, checksum)
       SELECT a.app_id, $2::text, a.owner_org, a.user_id, 'orgs/' || a.owner_org || '/apps/' || a.app_id || '/' || $2::text || '.zip', 'r2', 'deadbeef'
       FROM public.apps a WHERE a.app_id = $1
       RETURNING id`,
      [appId, name],
    )
    return Number(row.id)
  }

  async function insertDevices(count: number, platform: 'ios' | 'android', native: string, bundle: string) {
    await executeSQL(
      `INSERT INTO public.devices (updated_at, device_id, app_id, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator, version_name, default_channel)
       SELECT now(), $1::text || '-' || g, $2::text, $3::public.platform_os, '7.20.0', '18.0', $4::text, '', true, false, $5::text, 'production'
       FROM generate_series(1, $6::int) AS g`,
      [`${appId}-${platform}-${native}-${bundle}`, appId, platform, native, bundle, count],
    )
  }

  test.beforeAll(async () => {
    await resetAndSeedAppData(appId)
    const [channel] = await executeSQL<{ id: number }>(`SELECT id FROM public.channels WHERE app_id = $1 AND name = 'production'`, [appId])
    channelId = Number(channel.id)
    const previous = await insertBundle('1.9.3')
    const current = await insertBundle('1.9.4')
    await insertBundle('2.0.0')
    await executeSQL(`UPDATE public.channels SET ios = true, android = true, disable_auto_update = 'major', disable_auto_update_under_native = true, version = $2 WHERE id = $1`, [channelId, previous])
    await executeSQL(`UPDATE public.channels SET version = $2 WHERE id = $1`, [channelId, current])
    await executeSQL(`UPDATE public.deploy_history SET deployed_at = now() - interval '1 day' WHERE channel_id = $1 AND version_id = $2`, [channelId, previous])
    await insertDevices(6, 'ios', '1.9.0', '1.9.4')
    await insertDevices(3, 'android', '1.9.0', '1.9.4')
    await insertDevices(1, 'android', '2.0.0', '1.9.4')
  })

  test.afterAll(async () => {
    await executeSQL('DELETE FROM public.devices WHERE app_id = $1', [appId])
    await resetAppData(appId)
  })

  test('explains a major bump and asks how to revert before showing who is affected', async ({ page }) => {
    await page.route('**/private/sso/check-enforcement', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true }) }))
    await page.login('test@capgo.app', 'testtest')
    await page.goto(`/app/${appId}/channel/${channelId}`)
    await dismissSupportPrompt(page)

    const bundleRow = page.locator('[data-test="channel-bundle-row"]')
    await expect(bundleRow.getByRole('button', { name: '1.9.4', exact: true })).toBeVisible({ timeout: 30000 })

    // Setting the new major: only the device on the 2.0.0 store build gets it.
    await bundleRow.locator('[data-test="channel-change-bundle"]').click()
    await page.getByText('Link new bundle', { exact: true }).click()
    await page.getByRole('button', { name: /^2\.0\.0/ }).click()
    const impact = page.locator('[data-test="channel-impact-panel"]')
    await expect(page.locator('h3').filter({ hasText: 'Set 2.0.0 on production?' })).toBeVisible({ timeout: 15000 })
    await expect(impact.locator('[data-test="channel-impact-headline"]')).toContainText('1 of 10 devices (10%)', { timeout: 15000 })
    await expect(impact.locator('[data-test="channel-impact-strategy"]')).toContainText('9 devices run a store build below 2.0.0')
    await expect(impact.locator('[data-test="channel-impact-examples"] li')).toHaveCount(3)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // Revert asks first, then shows the impact of the picked choice.
    await bundleRow.locator('[data-test="channel-revert-builtin"]').click()
    await expect(page.locator('[data-test="channel-revert-choice-previous"]')).toContainText('Roll back to 1.9.3', { timeout: 15000 })
    await expect(impact).toHaveCount(0)
    await page.locator('[data-test="channel-revert-choice-previous"]').click()
    await expect(impact.locator('[data-test="channel-impact-headline"]')).toContainText('9 of 10 devices (90%)')
    await expect(page.locator('[data-test="channel-change-confirm"]')).toHaveText('Roll back to 1.9.3')
    await page.locator('[data-test="channel-revert-choice-builtin"]').click()
    await expect(impact.locator('[data-test="channel-impact-headline"]')).toContainText('10 of 10 devices (100%)')
    await expect(page.locator('[data-test="channel-change-confirm"]')).toHaveText('Revert to store version')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})
