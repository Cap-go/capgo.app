import type { Page } from '@playwright/test'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseWorktreeConfig } from '../../scripts/supabase-worktree-config'
import { getSupabaseStatus } from '../../scripts/supabase-worktree-status'
import { expect, test } from '../support/commands'
import { consoleQueryFromResponse, consoleQueryJson, routeConsoleQuery } from '../support/consoleQuery'

function localAdminClient() {
  const { ports } = getSupabaseWorktreeConfig()
  const configured = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  const status = configured ? null : getSupabaseStatus()
  const key = configured || status?.SERVICE_ROLE_KEY || status?.SECRET_KEY
  if (!key)
    throw new Error('Local Supabase service key is required for AI agent task fixtures')
  return createClient(`http://127.0.0.1:${ports.api}`, key, { auth: { persistSession: false } })
}

// Copying waits for the API key first, so poll until the prompt lands.
async function readClipboard(page: Page) {
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15000 }).not.toBe('')
  return page.evaluate(() => navigator.clipboard.readText())
}

test.describe('AI agent alternatives to manual actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.login('test@capgo.app', 'testtest')
    await page.evaluate(() => navigator.clipboard.writeText(''))
  })

  test('add app offers the AI agent or the manual wizard', async ({ page }) => {
    await page.goto('/app/new')
    await expect(page.locator('[data-test="add-app-setup-mode"]')).toBeVisible()

    await page.click('[data-test="add-app-setup-mode-ai"]')
    await page.locator('[data-test="ai-task-add-app"] [data-test="ai-task-copy-prompt"]').click()
    const prompt = await readClipboard(page)
    expect(prompt).toContain('npx install-mcp \'npx @capgo/cli@latest mcp\'')
    expect(prompt).toContain('I want to add a new app to it')
    await expect(page.locator('[data-test="add-app-ai-waiting"]')).toBeVisible()

    // The page opens the app the agent registers, and only that new one.
    const admin = localAdminClient()
    const { data: demo } = await admin.from('apps').select('owner_org').eq('app_id', 'com.demo.app').single()
    const appId = `com.agent.e2e${Date.now()}`
    const { error } = await admin.from('apps').insert({ app_id: appId, name: 'Agent app', owner_org: demo!.owner_org, icon_url: '' })
    expect(error).toBeNull()
    try {
      await page.waitForURL(new RegExp(`/app/${appId.replaceAll('.', '\\.')}/getting-started$`))
    }
    finally {
      await admin.from('apps').delete().eq('app_id', appId)
    }
    await page.goto('/app/new')
    await page.click('[data-test="add-app-setup-mode-ai"]')

    // The manual wizard starts on the app name for an organization that already has apps.
    const appName = page.getByRole('textbox', { name: 'App name' })
    await page.click('[data-test="add-app-ai-manual"]')
    await expect(appName).toBeVisible()

    // Coming from a manual choice skips the question.
    await page.goto('/app/new?mode=manual')
    await expect(appName).toBeVisible()
    await expect(page.locator('[data-test="add-app-setup-mode"]')).toHaveCount(0)
  })

  test('bundle upload offers a prompt for the AI agent', async ({ page }) => {
    await page.goto('/app/com.demo.app/bundles/new')
    await page.locator('[data-test="ai-task-upload-bundle"] [data-test="ai-task-copy-prompt"]').click()
    const prompt = await readClipboard(page)
    expect(prompt).toContain('{CAPGO_CLI_RUNNER} bundle upload com.demo.app --channel {CHANNEL_NAME}')
  })

  test('create channel offers a prompt for the AI agent', async ({ page }) => {
    await page.goto('/app/com.demo.app/channels')
    await page.click('[data-test="channel-add"]')
    const card = page.locator('[data-test="ai-task-create-channel"]')
    await expect(card).toBeVisible()
    await page.locator('#dialog-v2-content input[type="text"]').fill('beta')
    // After the copy the table counts channels once as its baseline; wait for it so the
    // channel inserted below counts as the agent's.
    const baseline = page.waitForResponse(response => consoleQueryFromResponse(response)?.name === 'channels')
    await card.locator('[data-test="ai-task-copy-prompt"]').click()
    const prompt = await readClipboard(page)
    expect(prompt).toContain('{CAPGO_CLI_RUNNER} channel add {CHANNEL_NAME} com.demo.app')
    expect(prompt).toContain('Use the channel name "beta"')
    // The agent creates the channel, so the dialog closes and the list picks it up.
    await expect(card).toHaveCount(0)
    await baseline
    const admin = localAdminClient()
    const { data: app } = await admin.from('apps').select('owner_org').eq('app_id', 'com.demo.app').single()
    const name = `agent-e2e-${Date.now()}`
    const { data: user } = await admin.from('users').select('id').eq('email', 'test@capgo.app').single()
    const { error } = await admin.from('channels').insert({ name, app_id: 'com.demo.app', owner_org: app!.owner_org, version: null, created_by: user!.id })
    expect(error).toBeNull()
    try {
      await expect(page.getByText(name)).toBeVisible({ timeout: 20000 })
    }
    finally {
      await admin.from('channels').delete().eq('app_id', 'com.demo.app').eq('name', name)
    }
  })

  test('hides the AI options from users who cannot create the API key they need', async ({ page }) => {
    // Answer "no" only for API key management; every other permission keeps its real result.
    await routeConsoleQuery(page, 'rbac_check_permission', (route, query) => {
      const key = (query.args[0] as { p_permission_key?: string } | undefined)?.p_permission_key
      return key === 'org.manage_apikeys' || key === 'app.manage_apikeys'
        ? route.fulfill(consoleQueryJson(false))
        : route.fallback()
    })

    await page.goto('/app/new')
    await expect(page.getByRole('textbox', { name: 'App name' })).toBeVisible()
    await expect(page.locator('[data-test="add-app-setup-mode"]')).toHaveCount(0)

    // Wait for the card's own permission answer, so the absence below is not just "not yet".
    const keyCheck = page.waitForResponse(response => (consoleQueryFromResponse(response)?.args[0] as { p_permission_key?: string } | undefined)?.p_permission_key === 'app.manage_apikeys')
    await page.goto('/app/com.demo.app/bundles/new')
    await keyCheck
    await expect(page.getByRole('button', { name: 'Invite a technical teammate' })).toBeVisible()
    await expect(page.locator('[data-test="ai-task-upload-bundle"]')).toHaveCount(0)
  })

  test('native builds offer the AI agent first, plus a teammate invite', async ({ page }) => {
    // The demo app has no builds in the seed: add one so the Builds tab shows its table and "Add".
    const admin = localAdminClient()
    const { data: app } = await admin.from('apps').select('owner_org').eq('app_id', 'com.demo.app').single()
    const { data: user } = await admin.from('users').select('id').eq('email', 'test@capgo.app').single()
    const now = new Date().toISOString()
    const { data: build, error } = await admin.from('build_requests').insert({
      app_id: 'com.demo.app',
      owner_org: app!.owner_org,
      requested_by: user!.id,
      platform: 'android',
      build_mode: 'release',
      build_config: {},
      status: 'succeeded',
      builder_job_id: `job-e2e-${Date.now()}`,
      upload_session_key: `e2e-${Date.now()}`,
      upload_path: 'e2e/build.zip',
      upload_url: 'https://builder.example.com/upload/e2e',
      upload_expires_at: now,
      created_at: now,
      updated_at: now,
    }).select('id').single()
    expect(error).toBeNull()
    try {
      await page.goto('/app/com.demo.app/builds')
      await page.getByRole('button', { name: 'Add', exact: true }).first().click()
      const card = page.locator('[data-test="ai-task-request-build"]')
      await expect(card).toBeVisible()
      await expect(page.locator('[data-test="build-invite-teammate"]')).toBeVisible()
      // AI first: the card sits above the manual CLI steps.
      const cardBox = await card.boundingBox()
      const firstStep = await page.locator('#build_step_0').boundingBox()
      expect(cardBox!.y).toBeLessThan(firstStep!.y)

      // Android already built, so the agent requests the build directly.
      await page.getByRole('button', { name: /Android/ }).first().click()
      await card.locator('[data-test="ai-task-copy-prompt"]').click()
      expect(await readClipboard(page)).toContain('{CAPGO_CLI_RUNNER} build request com.demo.app --platform android')
      // The page now waits for the build the agent requests.
      await expect(card).toHaveCount(0)
    }
    finally {
      await admin.from('build_requests').delete().eq('id', build!.id)
    }
  })

  test('proposes the manual way first after the user picked it', async ({ page }) => {
    const admin = localAdminClient()
    const { data: user } = await admin.from('users').select('id, onboarding').eq('email', 'test@capgo.app').single()
    const original = user!.onboarding
    const name = `manual-e2e-${Date.now()}`
    try {
      await page.goto('/app/com.demo.app/channels')
      await page.click('[data-test="channel-add"]')
      const dialog = page.locator('#dialog-v2-content')
      const card = dialog.locator('[data-test="ai-task-create-channel"]')
      const input = dialog.locator('input[type="text"]')
      await expect(card).toBeVisible()
      expect((await card.boundingBox())!.y).toBeLessThan((await input.boundingBox())!.y)

      // Creating the channel by hand makes manual the first proposal next time.
      await input.fill(name)
      await page.getByRole('button', { name: 'Confirm' }).click()
      await expect(page.getByText(name)).toBeVisible()
      await expect.poll(async () => {
        const { data } = await admin.from('users').select('onboarding').eq('id', user!.id).single()
        return (data?.onboarding as { setup_method?: string } | null)?.setup_method
      }).toBe('manual')

      await page.click('[data-test="channel-add"]')
      await expect(card).toBeVisible()
      expect((await card.boundingBox())!.y).toBeGreaterThan((await input.boundingBox())!.y)
    }
    finally {
      await admin.from('channels').delete().eq('app_id', 'com.demo.app').eq('name', name)
      await admin.from('users').update({ onboarding: original }).eq('id', user!.id)
    }
  })
})

