import type { Page } from '@playwright/test'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseWorktreeConfig } from '../../scripts/supabase-worktree-config'
import { getSupabaseStatus } from '../../scripts/supabase-worktree-status'
import { expect, test } from '../support/commands'

const { ports: supabasePorts } = getSupabaseWorktreeConfig()
const localSupabaseUrl = `http://127.0.0.1:${supabasePorts.api}`

function localAdminClient() {
  const configured = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  const status = configured ? null : getSupabaseStatus()
  const key = configured || status?.SERVICE_ROLE_KEY || status?.SECRET_KEY
  if (!key)
    throw new Error('Local Supabase service key is required for AI onboarding fixtures')
  return createClient(localSupabaseUrl, key, { auth: { persistSession: false } })
}

// Every test signs up a fresh user; remove it and everything it created afterwards.
const createdEmails: string[] = []

async function deleteSignup(email: string) {
  const admin = localAdminClient()
  const { data: user } = await admin.from('users').select('id').eq('email', email).maybeSingle()
  if (!user)
    return
  const { data: orgs } = await admin.from('orgs').select('id, customer_id').eq('created_by', user.id)
  for (const org of orgs ?? []) {
    await admin.from('apps').delete().eq('owner_org', org.id)
    await admin.from('org_users').delete().eq('org_id', org.id)
    await admin.from('orgs').delete().eq('id', org.id)
    if (org.customer_id)
      await admin.from('stripe_info').delete().eq('customer_id', org.customer_id)
  }
  await admin.from('apikeys').delete().eq('user_id', user.id)
  await admin.auth.admin.deleteUser(user.id)
}

async function registerAndName(page: Page, email: string) {
  createdEmails.push(email)
  await page.goto('/register/')
  await page.fill('[data-test="email"]', email)
  await page.fill('[data-test="password"]', 'Password123!')
  await page.click('[data-test="submit"]')
  await page.waitForURL(/\/onboarding\/name/)
  const welcome = page.locator('[data-test="onboarding-welcome-continue"]')
  const name = page.locator('[data-test="onboarding-name-step"]')
  await expect(welcome.or(name)).toBeVisible()
  if (await welcome.isVisible())
    await welcome.click()
  await page.fill('[data-test="onboarding-first-name"]', 'Example')
  await page.fill('[data-test="onboarding-last-name"]', 'User')
  await page.click('[data-test="onboarding-name-continue"]')
  await page.waitForURL(/\/onboarding\/app/)
  await expect(page.locator('[data-test="onboarding-setup-mode"]')).toBeVisible()
}

test.describe('AI onboarding', () => {
  test.afterEach(async () => {
    for (const email of createdEmails.splice(0))
      await deleteSignup(email).catch(error => console.warn('AI onboarding e2e cleanup failed', email, error))
  })

  test('creates the organization with the chosen plan and waits for the agent to register the app', async ({ page }) => {
    const email = `ai-onboarding-${Date.now()}@example.com`
    await registerAndName(page, email)

    await page.click('[data-test="onboarding-setup-mode-ai"]')
    const create = page.locator('[data-test="onboarding-ai-create-org"]')
    await expect(create).toBeDisabled()
    await expect(page.locator('[data-test="onboarding-ai-org-name"]')).toHaveValue('Example\'s organization')

    // A refresh keeps the user on the AI path.
    await page.reload()
    await expect(page.locator('[data-test="onboarding-ai-plan"]')).toBeVisible()

    await page.locator('[data-test="onboarding-ai-plan-option"]').nth(1).click()
    // The goal is required: it decides which Getting started checklist the app gets.
    await expect(create).toBeDisabled()
    await expect(page.locator('[data-test="onboarding-goal-decision-hint"]')).toBeVisible()
    await page.locator('[data-test="onboarding-ai-goal-ota"]').click()
    const orgRequest = page.waitForRequest(request => request.method() === 'POST' && /\/organization(?:\?|$)/.test(request.url()))
    await create.click()
    const body = (await orgRequest).postDataJSON()
    expect(body).toMatchObject({ name: 'Example\'s organization', developmentEnvironment: 'ai_assistant', startingOut: false, intent: 'ota' })
    expect(body.estimatedMau).toBeGreaterThan(0)

    await page.waitForURL(/\/onboarding\/ai\?org=/)
    const prompt = page.locator('[data-test="onboarding-ai-prompt"]')
    await expect(prompt).toContainText('npx install-mcp \'npx @capgo/cli@latest mcp\'')
    await expect(prompt).toContainText('start_capgo_live_update_onboarding')
    // The preview never shows the secret.
    await expect(prompt).toContainText('login capgo_••••')
    await expect(page.locator('[data-test="onboarding-ai-copy-prompt"]')).toBeEnabled()
    await expect(page.locator('[data-test="onboarding-ai-waiting"]')).toBeVisible()

    // Leaving before the agent registers the app brings the user back to the prompt.
    await page.goto('/dashboard')
    await page.waitForURL(/\/onboarding\/ai$/)

    const admin = localAdminClient()
    const { data: user } = await admin.from('users').select('id, onboarding').eq('email', email).single()

    // What /private/events records when the agent's CLI logs in and its MCP starts.
    const task = (n: number) => page.locator(`[data-test="onboarding-ai-task-${n}"]`)
    await expect(task(1)).toHaveAttribute('data-done', 'false')
    await admin.from('users').update({ onboarding: { ...(user!.onboarding as object), ai_agent_connected_at: new Date().toISOString() } }).eq('id', user!.id)
    await expect(task(1)).toHaveAttribute('data-done', 'true', { timeout: 15000 })
    await expect(task(2)).toHaveAttribute('data-done', 'false')
    await admin.from('users').update({ onboarding: { ...(user!.onboarding as object), ai_agent_connected_at: new Date().toISOString(), ai_mcp_connected_at: new Date().toISOString() } }).eq('id', user!.id)
    await expect(task(2)).toHaveAttribute('data-done', 'true', { timeout: 15000 })

    // What the MCP does next, through the real API with the prompt's key: register the app
    // in the new organization, identifying itself as the MCP like `capgo app add` does.
    const { data: org } = await admin.from('orgs').select('id').eq('created_by', user!.id).single()
    const { data: promptKey } = await admin.from('apikeys').select('key').eq('user_id', user!.id).eq('name', 'ai-onboarding').single()
    const appId = `com.example.ai${Date.now()}`
    const created = await fetch(`${localSupabaseUrl}/functions/v1/app`, {
      method: 'POST',
      headers: { 'authorization': promptKey!.key!, 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, name: 'Agent App', owner_org: org!.id, onboarding: { source: 'mcp' } }),
    })
    expect(created.status, await created.clone().text()).toBe(200)

    await expect(page.locator('[data-test="onboarding-ai-app-detected"]')).toContainText('Agent App', { timeout: 15000 })
    // No click: the page opens Getting started by itself, where the agent's progress shows live.
    await page.waitForURL(new RegExp(`/app/${appId.replaceAll('.', '\\.')}/getting-started$`))
    // AI setup shows the whole task list open, so the user can watch the agent tick tasks off.
    await expect(page.locator('[data-test="setup-checklist-toggle"]')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toBeVisible()
    // The agent logged in before the app existed; creating it with the key marks that step.
    await expect(page.locator('[data-test="app-onboarding-cli-step-login_cli_mcp"]')).toHaveAttribute('data-status', 'done')

    // "Create new organization" offers the AI setup again, pinned to the new organization.
    await page.goto('/onboarding/app?new_org=1')
    // A new organization gets the same three options as a new account.
    await expect(page.locator('[data-test="onboarding-setup-mode-invite"]')).toBeVisible()
    await page.click('[data-test="onboarding-setup-mode-ai"]')
    // The first organization already uses the default name.
    await expect(page.locator('[data-test="onboarding-ai-org-name"]')).toHaveValue('')
    await page.fill('[data-test="onboarding-ai-org-name"]', 'Second organization')
    await page.locator('[data-test="onboarding-ai-plan-option"]').first().click()
    await page.locator('[data-test="onboarding-ai-goal-builder"]').click()
    await page.click('[data-test="onboarding-ai-create-org"]')
    await page.waitForURL(/\/onboarding\/ai\?org=/)
    await expect(page.locator('[data-test="onboarding-ai-prompt"]')).toContainText('start_capgo_builder_onboarding')
    await expect(page.locator('[data-test="onboarding-ai-prompt"]')).toContainText('Second organization')
    // The first setup's agent markers do not carry over, and the existing app is not picked up.
    await expect(task(1)).toHaveAttribute('data-done', 'false')
    await expect(page.locator('[data-test="onboarding-ai-waiting"]')).toBeVisible()
    // An existing user can go back to their dashboard instead of only logging out.
    await expect(page.locator('[data-test="onboarding-cancel-new-org"]')).toBeVisible()
    await page.waitForTimeout(4000)
    await expect(page).toHaveURL(/\/onboarding\/ai\?org=/)
  })

  test('creates the organization and invites a technical teammate to finish the setup', async ({ page }) => {
    await registerAndName(page, `ai-invite-${Date.now()}@example.com`)
    await page.click('[data-test="onboarding-setup-mode-invite"]')
    const create = page.locator('[data-test="onboarding-ai-create-org"]')
    await expect(create).toBeDisabled()

    // A refresh keeps the user on the invite path.
    await page.reload()
    await expect(page.locator('[data-test="onboarding-ai-plan"]')).toBeVisible()

    await page.locator('[data-test="onboarding-ai-plan-option"]').nth(1).click()
    await page.locator('[data-test="onboarding-ai-goal-builder"]').click()
    const orgRequest = page.waitForRequest(request => request.method() === 'POST' && /\/organization(?:\?|$)/.test(request.url()))
    await create.click()
    const body = (await orgRequest).postDataJSON()
    expect(body).toMatchObject({ name: 'Example\'s organization', intent: 'builder' })
    expect(body.developmentEnvironment).toBeUndefined()

    // The invite dialog opens on its own once the organization exists.
    await expect(page.locator('[data-test="onboarding-invite-teammate"]')).toBeVisible()
    await page.fill('#invite-email', 'test2@capgo.app')
    await page.click('[data-test="invite-email-next"]')
    await expect(page.locator('[data-test="onboarding-invite-sent"]')).toContainText('test2@capgo.app')

    await page.click('[data-test="onboarding-invite-dashboard"]')
    await page.waitForURL(/\/dashboard/)
  })

  test('keeps the manual wizard one click away', async ({ page }) => {
    await registerAndName(page, `ai-manual-${Date.now()}@example.com`)
    await page.click('[data-test="onboarding-setup-mode-manual"]')
    await expect(page.locator('[data-test="onboarding-intent-ota"]')).toBeVisible()
    await page.reload()
    // The manual wizard may offer its own resume dialog; the setup choice never comes back.
    const resume = page.locator('[data-test="onboarding-resume-continue"]')
    const goal = page.locator('[data-test="onboarding-intent-ota"]')
    await expect(resume.or(goal)).toBeVisible()
    if (await resume.isVisible())
      await resume.click()
    await expect(goal).toBeVisible()
    await expect(page.locator('[data-test="onboarding-setup-mode"]')).toHaveCount(0)
  })
})
