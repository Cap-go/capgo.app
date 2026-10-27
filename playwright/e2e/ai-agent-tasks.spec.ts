import type { Page } from '@playwright/test'
import { expect, test } from '../support/commands'

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
    expect(prompt).toContain('{CAPGO_CLI_RUNNER} bundle upload com.demo.app')
  })

  test('create channel offers a prompt for the AI agent', async ({ page }) => {
    await page.goto('/app/com.demo.app/channels')
    await page.click('[data-test="channel-add"]')
    const card = page.locator('[data-test="ai-task-create-channel"]')
    await expect(card).toBeVisible()
    await page.locator('#dialog-v2-content input[type="text"]').fill('beta')
    await card.locator('[data-test="ai-task-copy-prompt"]').click()
    const prompt = await readClipboard(page)
    expect(prompt).toContain('{CAPGO_CLI_RUNNER} channel add {CHANNEL_NAME} com.demo.app')
    expect(prompt).toContain('Use the channel name "beta"')
    // The agent creates the channel, so the dialog closes.
    await expect(card).toHaveCount(0)
  })
})
