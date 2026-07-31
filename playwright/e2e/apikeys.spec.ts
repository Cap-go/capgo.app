import type { Locator, Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { getSupabaseClient, resetAndSeedAppData, resetAppData, USER_ID } from '../../tests/test-utils'
import { expect, test } from '../support/commands'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const INHERITED_ORG_ID = randomUUID()
const INHERITED_APP_ID = `com.apikeys.e2e.${randomUUID().replaceAll('-', '').slice(0, 12)}`
const INHERITED_CUSTOMER_ID = `cus_apikeys_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`

interface RoleBindingWithRole {
  scope_type: string
  app_id: string | null
  roles: { name: string } | { name: string }[] | null
}

function uniqueKeyName(prefix: string) {
  return `${prefix} ${Date.now().toString(36)}`
}

async function openCreateKeyDialog(page: Page) {
  await page.click('[data-test="create-key"]')
  const dialog = page.locator('#dialog-v2-content')
  await expect(dialog.locator('input[name="key-type"]')).toHaveCount(0)
  await expect(dialog.locator('[data-test="create-key-org-role-org_member"]')).toBeChecked()
  return dialog
}

async function expectApiKeyRow(page: Page, keyName: string) {
  const keyRow = page.locator('tr', { hasText: keyName })
  try {
    await expect(keyRow).toHaveCount(1, { timeout: 5000 })
  }
  catch {
    await page.reload()
    await expect(keyRow).toHaveCount(1)
  }
  return keyRow
}

async function selectOnlyOrgForCreation(page: Page, dialog: Locator, orgId: string) {
  await dialog.locator('[data-test="create-key-org-dropdown"]').click()
  const orgCheckboxes = dialog.locator('[data-test="create-key-org-checkbox"]')
  await expect(orgCheckboxes.first()).toBeVisible()

  const orgCount = await orgCheckboxes.count()
  for (let index = 0; index < orgCount; index++) {
    const checkbox = orgCheckboxes.nth(index)
    if (await checkbox.isDisabled())
      continue

    const shouldCheck = await checkbox.getAttribute('data-org-id') === orgId
    if (await checkbox.isChecked() === shouldCheck)
      continue

    if (shouldCheck)
      await checkbox.check()
    else
      await checkbox.uncheck()
  }

  const selectedOrg = dialog.locator(`[data-test="create-key-org-checkbox"][data-org-id="${orgId}"]`)
  await expect(selectedOrg).toBeChecked()
  await page.mouse.click(5, 5)
  await expect(dialog.locator('.fixed.inset-0.z-10')).toHaveCount(0)
}

async function fillApiKeyName(page: Page, dialog: Locator, keyName: string) {
  const nameInput = dialog.getByLabel('Name', { exact: true })
  await nameInput.click()
  await nameInput.pressSequentially(keyName)
  await expect(nameInput).toHaveValue(keyName)
  await nameInput.blur()
  await page.waitForTimeout(100)
}

async function createRbacApiKey(page: Page, keyName: string) {
  const dialog = await openCreateKeyDialog(page)
  await selectOnlyOrgForCreation(page, dialog, INHERITED_ORG_ID)
  await fillApiKeyName(page, dialog, keyName)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Added new API key successfully').first()).toBeVisible()
  const keyRow = await expectApiKeyRow(page, keyName)
  await expect(keyRow).toContainText('Member')
}

async function createSeededAppApiKey(page: Page, keyName: string) {
  const dialog = await openCreateKeyDialog(page)
  await selectOnlyOrgForCreation(page, dialog, INHERITED_ORG_ID)
  await fillApiKeyName(page, dialog, keyName)

  await dialog.locator('[data-test="create-key-add-app"]').click()
  const seededAppOption = dialog.locator('label', { hasText: INHERITED_APP_ID }).first()
  await expect(seededAppOption).toBeVisible()
  await seededAppOption.locator('[data-test="create-key-app-checkbox"]').check()

  const selectedApp = dialog.locator('[data-test="create-key-selected-app"]', { hasText: 'Seeded App' }).first()
  await expect(selectedApp).toBeVisible()
  await selectedApp.locator('[data-test="create-key-app-role-select"]').selectOption('app_developer')
  await page.mouse.click(5, 5)
  await expect(dialog.locator('.fixed.inset-0.z-10')).toHaveCount(0)

  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Added new API key successfully').first()).toBeVisible()
  return expectApiKeyRow(page, keyName)
}

async function createInheritedOrgAdminApiKey(page: Page, keyName: string) {
  const dialog = await openCreateKeyDialog(page)
  await selectOnlyOrgForCreation(page, dialog, INHERITED_ORG_ID)
  await fillApiKeyName(page, dialog, keyName)

  const orgAdminRole = dialog.locator('[data-test="create-key-org-role-org_admin"]')
  await expect(orgAdminRole).toBeVisible()
  await orgAdminRole.check({ force: true })
  await expect(orgAdminRole).toBeChecked()

  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Added new API key successfully').first()).toBeVisible()
  return expectApiKeyRow(page, keyName)
}

async function expectChannelPermissionOverridePersists(page: Page, keyRow: Locator, expectedAppText: string) {
  await keyRow.locator('[data-test^="manage-key-channel-permissions-"]').click()
  const panel = page.locator('[data-test="channel-permissions-panel"]')
  await expect(panel).toBeVisible()

  const appSelect = page.locator('[data-test="apikey-channel-permissions-app-select"]')
  await expect(appSelect).toContainText(expectedAppText)
  const targetAppOption = appSelect.locator('option', { hasText: expectedAppText }).first()
  await expect(targetAppOption).toBeAttached()
  const targetAppUuid = await targetAppOption.getAttribute('value')
  expect(targetAppUuid).toBeTruthy()
  await appSelect.selectOption(targetAppUuid!)
  await expect(appSelect).toHaveValue(targetAppUuid!)

  const promoteSelect = panel.locator('[data-test="channel-permission-select"][data-permission-key="channel.promote_bundle"]').first()
  await expect(promoteSelect).toBeVisible()
  const channelId = Number(await promoteSelect.getAttribute('data-channel-id'))
  expect(channelId).toBeGreaterThan(0)

  await promoteSelect.selectOption('deny')
  await expect(promoteSelect).toHaveValue('deny')
  await expect(promoteSelect).toBeEnabled()

  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await keyRow.locator('[data-test^="manage-key-channel-permissions-"]').click()
  await expect(panel).toBeVisible()
  await appSelect.selectOption(targetAppUuid!)
  await expect(appSelect).toHaveValue(targetAppUuid!)
  const reopenedPromoteSelect = page
    .locator(`[data-test="channel-permissions-panel"] [data-test="channel-permission-select"][data-permission-key="channel.promote_bundle"][data-channel-id="${channelId}"]`)
    .first()
  await expect(reopenedPromoteSelect).toBeVisible()
  await expect(reopenedPromoteSelect).toHaveValue('deny')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
}

test.describe('API Key Management', () => {
  test.beforeAll(async () => {
    await resetAndSeedAppData(INHERITED_APP_ID, {
      orgId: INHERITED_ORG_ID,
      userId: USER_ID,
      stripeCustomerId: INHERITED_CUSTOMER_ID,
    })
    const supabase = getSupabaseClient()
    const { data: role, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'org_super_admin')
      .single()
    expect(roleError).toBeNull()
    expect(role).not.toBeNull()

    const { data: binding, error: bindingError } = await supabase
      .from('role_bindings')
      .update({
        role_id: role!.id,
        granted_by: USER_ID,
        reason: 'Playwright API key test org super admin',
        is_direct: true,
      })
      .eq('principal_type', 'user')
      .eq('principal_id', USER_ID)
      .eq('scope_type', 'org')
      .eq('org_id', INHERITED_ORG_ID)
      .select('id')
      .single()
    expect(bindingError).toBeNull()
    expect(binding).not.toBeNull()
  })

  test.afterAll(async () => {
    await resetAppData(INHERITED_APP_ID)
    const supabase = getSupabaseClient()
    await supabase.from('role_bindings').delete().eq('org_id', INHERITED_ORG_ID)
    await supabase.from('org_users').delete().eq('org_id', INHERITED_ORG_ID)
    await supabase.from('orgs').delete().eq('id', INHERITED_ORG_ID)
    await supabase.from('stripe_info').delete().eq('customer_id', INHERITED_CUSTOMER_ID)
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ orgId, userId }) => {
      localStorage.setItem('capgo_current_org_id', orgId)
      sessionStorage.setItem('sso_enforcement_checked', JSON.stringify({
        timestamp: Date.now(),
        cachedUserId: userId,
      }))
    }, { orgId: INHERITED_ORG_ID, userId: USER_ID })
    // Login first
    await page.login('test@capgo.app', 'testtest')
    // Go to API keys page
    await page.goto('/apikeys')
  })

  test('should create new API key', async ({ page }) => {
    const keyName = uniqueKeyName('Read')

    await createRbacApiKey(page, keyName)
  })

  test('should select all manageable organizations by default with member role', async ({ page }) => {
    const dialog = await openCreateKeyDialog(page)

    await dialog.locator('[data-test="create-key-org-dropdown"]').click()
    const orgCheckboxes = dialog.locator('[data-test="create-key-org-checkbox"]:not(:disabled)')
    await expect(orgCheckboxes.first()).toBeVisible()

    const orgCount = await orgCheckboxes.count()
    expect(orgCount).toBeGreaterThan(0)
    for (let index = 0; index < orgCount; index++) {
      await expect(orgCheckboxes.nth(index)).toBeChecked()
    }

    await page.mouse.click(5, 5)
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('should configure app-level role bindings in the create dialog', async ({ page }) => {
    const dialog = await openCreateKeyDialog(page)

    await dialog.locator('[data-test="create-key-add-app"]').click()
    const appCheckboxes = dialog.locator('[data-test="create-key-app-checkbox"]')
    await expect(appCheckboxes.first()).toBeVisible()
    await appCheckboxes.first().check()

    const selectedApp = dialog.locator('[data-test="create-key-selected-app"]').first()
    await expect(selectedApp).toBeVisible()
    const roleSelect = selectedApp.locator('[data-test="create-key-app-role-select"]')
    await roleSelect.selectOption('app_reader')
    await expect(roleSelect).toHaveValue('app_reader')

    await page.mouse.click(5, 5)
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('should create and preserve an app-only preview key', async ({ page }) => {
    const keyName = uniqueKeyName('App Preview')
    const dialog = await openCreateKeyDialog(page)
    await selectOnlyOrgForCreation(page, dialog, INHERITED_ORG_ID)

    const appOnlyScope = dialog.locator('[data-test="create-key-app-only-scope"]')
    await appOnlyScope.check()
    await expect(appOnlyScope).toBeChecked()
    await expect(dialog.locator('[data-test^="create-key-org-role-"]')).toHaveCount(0)

    await fillApiKeyName(page, dialog, keyName)
    await dialog.locator('[data-test="create-key-add-app"]').click()
    const seededAppOption = dialog.locator('label', { hasText: INHERITED_APP_ID }).first()
    await expect(seededAppOption).toBeVisible()
    await seededAppOption.locator('[data-test="create-key-app-checkbox"]').check()

    const selectedApp = dialog.locator('[data-test="create-key-selected-app"]', { hasText: 'Seeded App' }).first()
    await expect(selectedApp).toBeVisible()
    const roleSelect = selectedApp.locator('[data-test="create-key-app-role-select"]')
    await roleSelect.selectOption('app_preview')
    await page.mouse.click(5, 5)

    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText('Added new API key successfully').first()).toBeVisible()
    const keyRow = await expectApiKeyRow(page, keyName)
    await expect(keyRow).toContainText('App Preview')
    await expect(keyRow.locator('td').nth(1)).toContainText('-')

    await page.reload()
    const reloadedKeyRow = await expectApiKeyRow(page, keyName)
    await expect(reloadedKeyRow).toContainText('App Preview')
    await expect(reloadedKeyRow.locator('td').nth(1)).toContainText('-')

    const supabase = getSupabaseClient()
    const { data: key, error: keyError } = await supabase
      .from('apikeys')
      .select('id, rbac_id')
      .eq('name', keyName)
      .single()
    expect(keyError).toBeNull()
    expect(key?.rbac_id).toBeTruthy()

    const assertAppOnlyBindings = async () => {
      const { data: bindings, error: bindingsError } = await supabase
        .from('role_bindings')
        .select('scope_type, app_id, roles(name)')
        .eq('principal_type', 'apikey')
        .eq('principal_id', key!.rbac_id)
      expect(bindingsError).toBeNull()

      const normalized = ((bindings ?? []) as unknown as RoleBindingWithRole[]).map(binding => ({
        scope_type: binding.scope_type,
        app_id: binding.app_id,
        role_name: Array.isArray(binding.roles) ? binding.roles[0]?.name : binding.roles?.name,
      }))
      expect(normalized).toEqual([
        expect.objectContaining({ scope_type: 'app', role_name: 'app_preview' }),
      ])
    }

    await assertAppOnlyBindings()

    await keyRow.locator('[data-test^="edit-key-"]').click()
    const editDialog = page.locator('#dialog-v2-content')
    await expect(editDialog.locator('[data-test="create-key-app-only-scope"]')).toBeChecked()
    await expect(editDialog.locator('[data-test^="create-key-org-role-"]')).toHaveCount(0)
    await expect(editDialog.locator('[data-test="create-key-app-role-select"]')).toHaveValue('app_preview')
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(page.locator('[data-test="toast"]')).toContainText('API key updated')

    await assertAppOnlyBindings()
  })

  test('should edit API key rights', async ({ page }) => {
    const keyName = `Playwright Edit Rights ${Date.now()}`

    await createRbacApiKey(page, keyName)

    const keyRow = page.locator('tr', { hasText: keyName })
    await expect(keyRow).toHaveCount(1)
    await keyRow.locator('[data-test^="edit-key-"]').click()

    const dialog = page.locator('#dialog-v2-content')
    await expect(page.getByRole('heading', { name: 'Edit API key' })).toBeVisible()
    await dialog.locator('[data-test="create-key-org-role-org_admin"]').check()
    await page.getByRole('button', { name: 'Confirm' }).click()

    const toast = page.locator('[data-test="toast"]')
    await expect(toast).toContainText('API key updated')
    await expect(keyRow).toContainText('Admin')
  })

  test('should create org-admin API key with organization creation permission', async ({ page }) => {
    const keyName = uniqueKeyName('Org Create')
    const dialog = await openCreateKeyDialog(page)
    await selectOnlyOrgForCreation(page, dialog, INHERITED_ORG_ID)
    await fillApiKeyName(page, dialog, keyName)

    const orgCreatePermission = dialog.locator('[data-test="create-key-org-create-permission"]')
    await expect(orgCreatePermission).toBeDisabled()

    await dialog.locator('[data-test="create-key-org-role-org_admin"]').check()
    await expect(orgCreatePermission).toBeEnabled()
    await orgCreatePermission.check()

    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText('Added new API key successfully').first()).toBeVisible()
    await expectApiKeyRow(page, keyName)

    await page.reload()
    const keyRow = page.locator('tr', { hasText: keyName })
    await expect(keyRow).toHaveCount(1)
    await keyRow.locator('[data-test^="edit-key-"]').click()

    const editDialog = page.locator('#dialog-v2-content')
    await expect(editDialog.locator('[data-test="create-key-org-create-permission"]')).toBeChecked()
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('should manage channel permission overrides for app-scoped API keys', async ({ page }) => {
    const keyName = uniqueKeyName('Channel')
    const keyRow = await createSeededAppApiKey(page, keyName)

    await expectChannelPermissionOverridePersists(page, keyRow, 'Seeded App')
  })

  test('should manage inherited org-admin channel permissions for API keys', async ({ page }) => {
    const keyName = uniqueKeyName('Inherited')
    const keyRow = await createInheritedOrgAdminApiKey(page, keyName)

    await expectChannelPermissionOverridePersists(page, keyRow, 'Seeded App · App Admin')
  })

  test('should delete API key', async ({ page }) => {
    const keyName = uniqueKeyName('Delete')

    await createRbacApiKey(page, keyName)

    const keyCell = page.getByText(keyName, { exact: true })
    await expect(keyCell).toBeVisible()
    const keyRow = keyCell.locator('xpath=ancestor::tr[1]')

    await keyRow.locator('[data-test^="delete-key-"]').click()
    await page.getByRole('button', { name: 'Delete' }).click()

    await expect(page.getByText('API key has been successfully deleted', { exact: true })).toBeVisible()
    await expect(page.getByText(keyName, { exact: true })).toHaveCount(0)
  })
})
