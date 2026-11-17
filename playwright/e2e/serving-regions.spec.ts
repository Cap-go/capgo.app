import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { env } from 'node:process'
import { getSupabaseStatus } from '../../scripts/supabase-worktree-status'
import { createClient } from '../../tests/sql-data-client'
import { expect, test } from '../support/commands'
import { consoleQueryError, consoleQueryPayload, forwardConsoleQuery, routeConsoleQuery } from '../support/consoleQuery'

const APP_ID = 'com.example.serving.e2e'
const regions = ['EU', 'NA', 'SA', 'OC', 'AS_INDIA', 'AS_JAPAN', 'HK', 'AF', 'ME']

test('production CSP permits the serving policy check', async ({ page }) => {
  const appId = 'com.example.policy-csp'
  const url = `https://plugin.eu.capgo.app/serving_policy/${appId}`
  const csp = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8').match(/^  Content-Security-Policy: (.+)$/m)?.[1]
  if (!csp)
    throw new Error('Missing production CSP fixture')
  await page.route('https://console.capgo.app/policy-status-fixture', route => route.fulfill({
    contentType: 'text/html',
    headers: { 'content-security-policy': csp },
    body: '<!doctype html><html><body>Policy status fixture</body></html>',
  }))
  let requests = 0
  await page.route(url, (route) => {
    requests++
    return route.fulfill({ headers: { 'access-control-allow-origin': 'https://console.capgo.app' }, json: { app_id: appId, active: false } })
  })
  await page.goto('https://console.capgo.app/policy-status-fixture')
  const result = await page.evaluate(async (endpoint) => {
    const response = await fetch(endpoint, { cache: 'no-store' })
    return { status: response.status, body: await response.json() }
  }, url)
  expect(result).toEqual({ status: 200, body: { app_id: appId, active: false } })
  expect(requests).toBe(1)
})

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
    await page.route('**/serving_policy/**', route => route.fulfill({ json: { app_id: APP_ID, active: true, policy: { regions, mode: 'route' } } }))
    await page.login('test@capgo.app', 'testtest')
    await page.goto(`/app/${APP_ID}/settings`)
    // Repository uses data-test rather than Playwright's default test id.
    const controls = page.locator('[data-test="serving-regions"]')
    await expect(controls).toBeVisible()
    for (const region of regions)
      await expect(controls.locator(`input[name="serving-region-${region}"]`)).toBeChecked()
    const mode = controls.getByRole('combobox', { name: 'Requests outside these regions' })
    await expect(mode).toHaveValue('route')
    for (const region of regions.filter(region => region !== 'NA'))
      await controls.locator(`input[name="serving-region-${region}"]`).uncheck()
    await mode.selectOption('block')
    const savedBlock = page.waitForResponse(response => response.request().postData()?.includes('serving_regions') === true)
    await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
    expect((await savedBlock).ok()).toBe(true)
    await page.reload()
    await expect(mode).toHaveValue('block')
    await expect(controls.getByRole('status')).toHaveText('Applying your changes.')
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
    await expect(controls.getByRole('status')).toHaveText('Up to date.')
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

    let deniedSettingsChecks = 0
    await routeConsoleQuery(page, 'rbac_check_permissions', (route, query) => {
      const checks = consoleQueryPayload(query)?.p_checks ?? []
      return forwardConsoleQuery(route, (row: { idx: number, allowed: boolean }) => {
        const check = checks[row.idx]
        if (check?.permission_key !== 'app.update_settings' || check.app_id !== APP_ID)
          return row
        deniedSettingsChecks++
        return { ...row, allowed: false }
      })
    })
    await page.reload()
    await expect.poll(() => deniedSettingsChecks).toBeGreaterThan(0)
    await expect(mode).toBeDisabled()
    for (const region of regions)
      await expect(controls.locator(`input[name="serving-region-${region}"]`)).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Delete app', exact: true })).toBeEnabled()
  }
  finally {
    await admin.from('apps').delete().eq('app_id', APP_ID)
  }
})

const settingsTest = test.extend<{ servingApp: { appId: string, admin: ReturnType<typeof createClient> } }>({
  servingApp: async ({ page }, use) => {
    const status = getSupabaseStatus()
    if (!status)
      throw new Error('Local Supabase must be running')
    env.SUPABASE_DB_URL ??= status.DB_URL
    const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data: demo } = await admin.from('apps').select('owner_org,user_id').eq('app_id', 'com.demo.app').single()
    if (!demo)
      throw new Error('Missing demo fixture')
    const appId = `com.example.serving.${randomUUID()}`
    const inserted = await admin.from('apps').insert({
      app_id: appId,
      owner_org: demo.owner_org,
      user_id: demo.user_id,
      name: 'Serving regions save e2e',
      icon_url: '',
    })
    expect(inserted.error).toBeNull()
    try {
      await page.route('**/serving_policy/**', route => route.fulfill({ json: { app_id: appId, active: true, policy: { regions, mode: 'route' } } }))
      await page.login('test@capgo.app', 'testtest')
      await page.goto(`/app/${appId}/settings`)
      await expect(page.locator('[data-test="serving-regions"]')).toBeVisible()
      await use({ appId, admin })
    }
    finally {
      await admin.from('apps').delete().eq('app_id', appId)
    }
  },
})

settingsTest('does not offer regional settings before the service can apply them', async ({ page, servingApp }) => {
  const { admin, appId } = servingApp
  await page.route('**/serving_policy/**', route => route.fulfill({ json: { app_id: appId, active: false } }))
  await page.reload()
  await expect(page.locator('[name="app_name"]')).toBeVisible()
  await expect(page.locator('[data-test="serving-regions"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Check published policy' })).toHaveCount(0)
  const saved = await admin.from('apps').select('serving_regions,serving_region_mode').eq('app_id', appId).single()
  expect(saved.data).toEqual({ serving_regions: regions, serving_region_mode: 'route' })
})

settingsTest('saves the name and later settings when a serving-policy edit is rejected', async ({ page, servingApp }) => {
  const { admin, appId } = servingApp
  await page.locator('[name="app_name"]').fill('Saved despite policy failure')
  await page.locator('[name="allow_preview"]').check()
  await page.locator('[name="serving-region-EU"]').uncheck()
  let policyAttempts = 0
  await routeConsoleQuery(page, 'apps', (route, query) => {
    if (consoleQueryPayload(query)?.serving_regions) {
      policyAttempts++
      return route.fulfill(consoleQueryError(403, { code: '42501', message: 'Policy update unavailable' }))
    }
    return route.fallback()
  })
  await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => {
    const saved = await admin.from('apps').select('name,allow_preview,serving_regions').eq('app_id', appId).single()
    return saved.data
  }).toEqual({ name: 'Saved despite policy failure', allow_preview: true, serving_regions: regions })
  expect(policyAttempts).toBe(1)
  await expect(page.getByText('Policy update unavailable', { exact: true })).toBeVisible()
})

settingsTest('does not overwrite a newer policy when a stale form saves only the name', async ({ page, servingApp }) => {
  const { admin, appId } = servingApp
  const newerPolicy = { serving_regions: ['NA'], serving_region_mode: 'block' }
  const changed = await admin.from('apps').update(newerPolicy).eq('app_id', appId)
  expect(changed.error).toBeNull()
  await page.locator('[name="app_name"]').fill('Name from stale settings')
  await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => {
    const saved = await admin.from('apps').select('name,serving_regions,serving_region_mode').eq('app_id', appId).single()
    return saved.data
  }).toEqual({ name: 'Name from stale settings', ...newerPolicy })
})

settingsTest('ignores region order and advances the baseline after intentional policy saves', async ({ page, servingApp }) => {
  const { admin, appId } = servingApp
  let policyWrites = 0
  await routeConsoleQuery(page, 'apps', (route, query) => {
    if (consoleQueryPayload(query)?.serving_regions)
      policyWrites++
    return route.fallback()
  })
  const europe = page.locator('[name="serving-region-EU"]')
  await europe.uncheck()
  await europe.check()
  await page.locator('[name="app_name"]').fill('Same regions in another order')
  const save = page.locator('#update-app').getByRole('button', { name: 'Save', exact: true })
  await save.click()
  await expect(page.locator('[name="app_name"]')).toHaveValue('Same regions in another order')
  expect(policyWrites).toBe(0)

  await europe.uncheck()
  await page.locator('[name="serving_region_mode"]').selectOption('block')
  await save.click()
  await expect.poll(async () => {
    const saved = await admin.from('apps').select('serving_regions,serving_region_mode').eq('app_id', appId).single()
    return saved.data
  }).toEqual({ serving_regions: regions.filter(region => region !== 'EU'), serving_region_mode: 'block' })
  await expect(page.locator('[name="app_name"]')).toBeVisible()
  expect(policyWrites).toBe(1)

  await page.locator('[name="serving_region_mode"]').selectOption('route')
  await save.click()
  await expect.poll(async () => {
    const saved = await admin.from('apps').select('serving_regions,serving_region_mode').eq('app_id', appId).single()
    return saved.data
  }).toEqual({ serving_regions: regions.filter(region => region !== 'EU'), serving_region_mode: 'route' })
  await expect(page.locator('[name="app_name"]')).toBeVisible()
  expect(policyWrites).toBe(2)

  const newerPolicy = { serving_regions: ['NA'], serving_region_mode: 'block' }
  const changed = await admin.from('apps').update(newerPolicy).eq('app_id', appId)
  expect(changed.error).toBeNull()
  await page.locator('[name="app_name"]').fill('Name after policy save')
  await save.click()
  await expect.poll(async () => {
    const saved = await admin.from('apps').select('name,serving_regions,serving_region_mode').eq('app_id', appId).single()
    return saved.data
  }).toEqual({ name: 'Name after policy save', ...newerPolicy })
  expect(policyWrites).toBe(2)
})
