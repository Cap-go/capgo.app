import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseWorktreeConfig } from '../../scripts/supabase-worktree-config'
import { getSupabaseStatus } from '../../scripts/supabase-worktree-status'
import { expect, test } from '../support/commands'

const APP_ID = 'com.bundlealert.e2e'

function localAdminClient() {
  const { ports } = getSupabaseWorktreeConfig()
  const configured = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  const status = configured ? null : getSupabaseStatus()
  const key = configured || status?.SERVICE_ROLE_KEY || status?.SECRET_KEY
  if (!key)
    throw new Error('Local Supabase service key is required for the alert-scope fixture')
  return createClient(`http://127.0.0.1:${ports.api}`, key, { auth: { persistSession: false } })
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
  }
  finally {
    await admin.from('apps').delete().eq('app_id', APP_ID)
  }
})
