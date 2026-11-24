import { env } from 'node:process'
import { getSupabaseStatus } from '../../scripts/supabase-worktree-status'
import { createClient } from '../../tests/sql-data-client'
import { expect, test } from '../support/commands'

const APP_ID = 'com.bundlealert.e2e'

function localAdminClient() {
  const status = getSupabaseStatus()
  const url = env.SUPABASE_URL || status?.API_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || status?.SERVICE_ROLE_KEY || status?.SECRET_KEY
  const dbUrl = env.SUPABASE_DB_URL || env.DB_URL || status?.DB_URL
  if (!url || !key || !dbUrl)
    throw new Error('Local Supabase URL, service key, and database URL are required for the alert-scope fixture')
  env.SUPABASE_DB_URL ??= dbUrl
  return createClient(url, key, { auth: { persistSession: false } })
}

test('saves and reloads the incompatible-bundle alert scope', async ({ page }) => {
  const admin = localAdminClient()
  const { data: demo, error: demoError } = await admin.from('apps').select('owner_org, user_id').eq('app_id', 'com.demo.app').single()
  expect(demoError).toBeNull()
  const { error: insertError } = await admin.from('apps').insert({
    app_id: APP_ID,
    name: 'Bundle alert e2e',
    owner_org: demo!.owner_org,
    user_id: demo!.user_id,
    icon_url: '',
  })
  expect(insertError).toBeNull()

  try {
    await page.login('test@capgo.app', 'testtest')
    await page.goto(`/app/${APP_ID}/settings`)

    const scope = page.locator('#bundle-incompatible-alert')
    await expect(scope).toBeVisible()
    await expect(scope).toHaveValue('default')

    await scope.selectOption('all')
    await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Updated incompatible bundle alerts')).toBeVisible()

    await page.reload()
    await expect(scope).toHaveValue('all')

    await scope.selectOption('default')
    await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Updated incompatible bundle alerts')).toBeVisible()
    await page.reload()
    await expect(scope).toHaveValue('default')

    const { data: channel } = await admin.from('channels').insert({
      app_id: APP_ID,
      name: 'development',
      owner_org: demo!.owner_org,
      created_by: demo!.user_id,
    }).select('id').single().throwOnError()
    await page.goto(`/app/${APP_ID}/channel/${channel!.id}`)
    const override = page.getByRole('combobox', { name: 'Incompatible bundle alerts' })
    for (const choice of ['false', 'true', 'inherit']) {
      await override.selectOption(choice)
      await expect.poll(async () => {
        const { data } = await admin.from('channels').select('bundle_alert_enabled').eq('id', channel!.id).single().throwOnError()
        return data!.bundle_alert_enabled
      }).toBe(choice === 'inherit' ? null : choice === 'true')
      await page.reload()
      await expect(override).toHaveValue(choice)
    }
  }
  finally {
    await admin.from('apps').delete().eq('app_id', APP_ID)
  }
})
