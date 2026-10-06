import { expect, test } from '../support/commands'

test('organization admins can add, verify, copy and remove a custom domain', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  let domain: Record<string, unknown> | null = null
  const requests: string[] = []
  await page.route('**/private/custom_domains/*', async (route) => {
    const method = route.request().method()
    requests.push(method)
    if (method === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ hostname: 'updates.example.com' })
      domain = { hostname: 'updates.example.com', status: 'pending', dns_records: [{ type: 'CNAME', name: 'updates.example.com', value: 'customers.capgo.app' }], errors: [], endpoints: null }
    }
    else if (method === 'DELETE') {
      domain = null
    }
    else if (domain) {
      domain = { ...domain, status: 'active', endpoints: { updateUrl: 'https://updates.example.com/updates', statsUrl: 'https://updates.example.com/stats', channelUrl: 'https://updates.example.com/channel_self' } }
    }
    await route.fulfill({ json: { domain } })
  })
  await page.login('test@capgo.app', 'testtest')
  const supportPrompt = page.getByRole('button', { name: 'Remind me later' })
  if (await supportPrompt.isVisible())
    await supportPrompt.click()
  await page.goto('/settings/organization')
  const section = page.locator('[data-test="custom-domain-settings"]')
  await expect(section).toBeVisible()
  await section.getByLabel('Hostname').fill('updates.example.com')
  await section.getByRole('button', { name: 'Add domain', exact: true }).click()
  await expect(section.getByText('Pending verification', { exact: true })).toBeVisible()
  await expect(section.getByText('customers.capgo.app', { exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Copy updater configuration' })).toHaveCount(0)
  await section.getByRole('button', { name: 'Refresh status' }).click()
  await expect(section.getByText('Active', { exact: true })).toBeVisible()
  await expect(section.locator('pre')).toContainText('https://updates.example.com/channel_self')
  await expect(section.getByRole('button', { name: 'Copy updater configuration' })).toBeVisible()
  await section.getByRole('button', { name: 'Copy updater configuration' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('https://updates.example.com/channel_self')
  await section.getByRole('button', { name: 'Remove domain', exact: true }).click()
  expect(requests).not.toContain('DELETE')
  await section.getByRole('button', { name: 'Confirm removal' }).click()
  await expect(section.getByLabel('Hostname')).toBeVisible()
  expect(requests).toContain('DELETE')
})
