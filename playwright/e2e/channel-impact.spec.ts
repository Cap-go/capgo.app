import { randomUUID } from 'node:crypto'
import { executeSQL, resetAndSeedAppData, resetAppData } from '../../tests/test-utils'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

// Devices on old and new store builds, so the preview has to explain why a
// major bump only reaches devices that installed the new store build.
test.describe('channel change impact preview (isolated app)', () => {
  const appId = `com.impact.e2e.${randomUUID().slice(0, 8)}`
  let channelId = 0

  async function insertBundle(name: string, nativePackages: { name: string, version: string }[] = []) {
    const [row] = await executeSQL<{ id: number }>(
      `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, r2_path, storage_provider, checksum, native_packages)
       SELECT a.app_id, $2::text, a.owner_org, a.user_id, 'orgs/' || a.owner_org || '/apps/' || a.app_id || '/' || $2::text || '.zip', 'r2', 'deadbeef',
         ARRAY(SELECT jsonb_array_elements($3::jsonb))
       FROM public.apps a WHERE a.app_id = $1
       RETURNING id`,
      [appId, name, JSON.stringify(nativePackages)],
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
    // The previous bundle needs a camera plugin major the current bundle does not ship.
    const previous = await insertBundle('1.9.3', [{ name: '@capacitor/camera', version: '7.0.0' }])
    const current = await insertBundle('1.9.4', [{ name: '@capacitor/camera', version: '6.0.0' }])
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
    await expect(impact.locator('[data-test="channel-impact-headline"]')).toContainText('1 of 10 active devices (10%) will get 2.0.0', { timeout: 15000 })
    await expect(impact.locator('[data-test="channel-impact-strategy"]')).toContainText('Store builds below 2.0.0 keep their current bundle')
    // At most three example devices: one that gets it, the main blocker, another store build.
    await expect(impact.locator('[data-test="channel-impact-examples"] li')).toHaveCount(3)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // Revert asks first, then shows the impact of the picked choice.
    await bundleRow.locator('[data-test="channel-revert-builtin"]').click()
    await expect(page.locator('[data-test="channel-revert-choice-previous"]')).toContainText('Roll back to 1.9.3', { timeout: 15000 })
    await expect(impact).toHaveCount(0)
    await page.locator('[data-test="channel-revert-choice-previous"]').click()
    await expect(impact.locator('[data-test="channel-impact-headline"]')).toContainText('9 of 10 active devices (90%) will get 1.9.3')
    await expect(page.locator('[data-test="channel-change-confirm"]')).toHaveText('Roll back to 1.9.3')
    // Rolling back brings back native packages the current bundle does not ship.
    await expect(page.locator('[data-test="channel-change-compat"]')).toContainText('@capacitor/camera')
    await expect(page.getByRole('button', { name: 'View dependencies', exact: true })).toBeVisible()
    await page.locator('[data-test="channel-revert-choice-builtin"]').click()
    await expect(page.locator('[data-test="channel-change-compat"]')).toHaveCount(0)
    await expect(impact.locator('[data-test="channel-impact-headline"]')).toContainText('10 of 10 active devices (100%) will go back to the store version')
    await expect(page.locator('[data-test="channel-change-confirm"]')).toHaveText('Revert to store version')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // A rollout says who gets the bundle first, not who switches now.
    const [rolloutTarget] = await executeSQL<{ id: number }>(`SELECT id FROM public.app_versions WHERE app_id = $1 AND name = '1.9.3'`, [appId])
    await executeSQL(`UPDATE public.channels SET rollout_version = $2, rollout_enabled = true, rollout_percentage_bps = 5000 WHERE id = $1`, [channelId, rolloutTarget.id])
    await page.reload()
    await dismissSupportPrompt(page)
    await page.locator('[data-test="rollout-change-target"]').click({ timeout: 30000 })
    await page.getByRole('button', { name: /^2\.0\.0/ }).click()
    await expect(page.locator('h3').filter({ hasText: 'Roll out 2.0.0 to 50% of production?' })).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-test="channel-change-rollout-note"]')).toHaveText('Replaces 1.9.3 as the rollout target.')
    await expect(page.getByText('production keeps serving 1.9.4 to devices outside the rollout.')).toBeVisible()
    const rolloutHeadline = impact.locator('[data-test="channel-impact-headline"]')
    await expect(rolloutHeadline).toContainText('About 1 device gets 2.0.0 first.', { timeout: 15000 })
    await expect(rolloutHeadline).toContainText('1 of 10 active devices can take 2.0.0. The rollout picks 50% of them.')
    await expect(impact.locator('[data-test="channel-impact-examples"]')).toContainText('Eligible for the rollout')
    await expect(page.locator('[data-test="channel-change-confirm"]')).toHaveText('Start rollout')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // Setting the rollout's own bundle as stable ends the rollout, on its own line.
    await bundleRow.locator('[data-test="channel-change-bundle"]').click()
    await page.getByText('Link new bundle', { exact: true }).click()
    await page.getByRole('button', { name: /^1\.9\.3/ }).click()
    await expect(page.locator('[data-test="channel-change-rollout-note"]')).toHaveText('Ends the progressive rollout: 1.9.3 is no longer limited to a share of devices.', { timeout: 15000 })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})
