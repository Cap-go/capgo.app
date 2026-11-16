import { env } from 'node:process'
import { getSupabaseStatus } from '../../scripts/supabase-worktree-status'
import { createClient } from '../../tests/sql-data-client'
import { expect, test } from '../support/commands'
import { consoleQueryJson, consoleQueryPayload, routeConsoleQuery } from '../support/consoleQuery'

const APP_ID = 'com.example.serving.e2e'
const regions = ['EU', 'NA', 'SA', 'OC', 'AS_INDIA', 'AS_JAPAN', 'HK', 'AF', 'ME']

test('saves and reloads serving regions and both outside-region modes', async ({ page }) => {
  const status = getSupabaseStatus()
  if (!status)
    throw new Error('Local Supabase must be running')
  env.SUPABASE_DB_URL ??= status.DB_URL
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { data: demo } = await admin.from('apps').select('owner_org,user_id').eq('app_id', 'com.demo.app').single()
  if (!demo)
    throw new Error('Missing demo fixture')
  const inserted = await admin.from('apps').insert({ app_id: APP_ID, owner_org: demo.owner_org, user_id: demo.user_id, name: 'Serving regions e2e', icon_url: '' })
  expect(inserted.error).toBeNull()
  try {
    await page.route('https://plugin.eu.capgo.app/serving_policy/**', route => route.fulfill({ json: { app_id: APP_ID, active: false, phase: 'disabled' } }))
    await page.login('test@capgo.app', 'testtest')
    await page.goto(`/app/${APP_ID}/settings`)
    // Repository uses data-test rather than Playwright's default test id.
    const controls = page.locator('[data-test="serving-regions"]')
    await expect(controls).toBeVisible()
    for (const region of regions)
      await expect(controls.locator(`input[name="serving-region-${region}"]`)).toBeChecked()
    const mode = controls.getByRole('combobox', { name: 'Requests from elsewhere' })
    await expect(mode).toHaveValue('route')
    for (const region of regions.filter(region => region !== 'NA'))
      await controls.locator(`input[name="serving-region-${region}"]`).uncheck()
    await mode.selectOption('block')
    const savedBlock = page.waitForResponse(response => response.request().postData()?.includes('serving_regions') === true)
    await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
    expect((await savedBlock).ok()).toBe(true)
    await page.reload()
    await expect(mode).toHaveValue('block')
    await controls.getByRole('button', { name: 'Check published policy' }).click()
    await expect(controls.getByRole('status')).toContainText('pending')
    await page.setViewportSize({ width: 1280, height: 1200 })
    await controls.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await controls.screenshot({ path: '.context/serving-followup-block-pending.png' })
    await expect(controls.locator('input[name="serving-region-NA"]')).toBeChecked()
    await expect(controls.locator('input[name="serving-region-EU"]')).not.toBeChecked()
    await controls.locator('input[name="serving-region-NA"]').uncheck()
    await expect(controls.getByRole('alert')).toHaveText('Select at least one serving region.')
    await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
    const noEmpty = await admin.from('apps').select('serving_regions').eq('app_id', APP_ID).single()
    expect(noEmpty.data?.serving_regions).toEqual(['NA'])
    for (const region of regions)
      await controls.locator(`input[name="serving-region-${region}"]`).check()
    await mode.selectOption('route')
    const savedRoute = page.waitForResponse(response => response.request().postData()?.includes('serving_regions') === true)
    await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
    expect((await savedRoute).ok()).toBe(true)
    await page.reload()
    await expect(mode).toHaveValue('route')
    await controls.getByRole('button', { name: 'Check published policy' }).click()
    await expect(controls.getByRole('status')).toContainText('pending')
    await page.setViewportSize({ width: 1280, height: 1200 })
    await controls.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await controls.screenshot({ path: '.context/serving-followup-route-pending.png' })
    for (const region of regions)
      await expect(controls.locator(`input[name="serving-region-${region}"]`)).toBeChecked()
    const europe = controls.getByRole('checkbox', { name: 'Europe', exact: true })
    await europe.focus()
    await europe.press('Space')
    await expect(europe).not.toBeChecked()
    await europe.press('Space')
    await expect(europe).toBeChecked()
    await expect(page.getByRole('group', { name: 'Serving regions' })).toBeVisible()

    await routeConsoleQuery(page, 'rbac_check_permission', (route, query) => {
      if (consoleQueryPayload(query)?.p_permission_key === 'app.update_settings')
        return route.fulfill(consoleQueryJson(false))
      return route.fallback()
    })
    await page.reload()
    await expect(mode).toBeDisabled()
    for (const region of regions)
      await expect(controls.locator(`input[name="serving-region-${region}"]`)).toBeDisabled()
  }
  finally {
    await admin.from('apps').delete().eq('app_id', APP_ID)
  }
})
