import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const fixture = '/playwright/fixtures/onboarding-setup.html?view=cicd'
const appId = 'com.example.onboarding-preview'

function previewState(page: Page) {
  return page.evaluate(() => (window as any).onboardingSetupPreview.state)
}

test.describe('CI/CD setup guide', () => {
  test('guides live updates from main through GitHub Actions step by step', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(fixture)
    await expect(page.getByRole('heading', { name: 'Automate releases with CI/CD' })).toBeVisible()
    await expect(page.locator('[data-test="cicd-product-ota"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-test="cicd-strategy-main"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-test="cicd-strategy-main"]')).toContainText('Every merge to main ships a live update to the production channel.')
    await expect(page.locator('[data-test="cicd-steps"]')).toHaveCount(0)
    await expect(page.locator('[data-test="cicd-choose-provider"]')).toBeVisible()

    await page.locator('[data-test="cicd-provider-github"]').click()
    const steps = page.locator('[data-test="cicd-steps"]')
    await expect(steps.getByRole('heading', { name: 'Set up GitHub Actions' })).toBeVisible()
    await expect(steps.locator('[data-test^="cicd-step-"]')).toHaveCount(4)
    await expect(page.locator('[data-test="cicd-pipeline-file"]')).toHaveText('.github/workflows/capgo.yml')
    const content = page.locator('[data-test="cicd-pipeline-content"]')
    await expect(content).toContainText("branches: ['main']")
    await expect(content).toContainText(`npx @capgo/cli@latest bundle upload ${appId} --channel production --auto-bump patch --fail-on-incompatible`)
    await expect(content).toContainText('CAPGO_TOKEN: ${{ secrets.CAPGO_TOKEN }}')
    await expect(page.locator('[data-test="cicd-step-secret"]')).toContainText('Store release keys as capgo-release environment secrets and preview keys as repository secrets.')
    await expect(page.locator('[data-test="cicd-step-secret"]')).toContainText('gh secret set CAPGO_TOKEN')
    await expect(page.locator('[data-test="cicd-detection"]')).toContainText('Waiting for the first bundle uploaded from CI…')

    const keyCard = page.locator('[data-test="cicd-key-CAPGO_TOKEN"]')
    await expect(keyCard).toContainText('Role: App uploader')
    await keyCard.locator('[data-test="cicd-create-key-CAPGO_TOKEN"]').click()
    await expect(keyCard.locator('[data-test="cicd-key-value-CAPGO_TOKEN"]')).toHaveText('cap_ci_preview_key_1')
    await expect(keyCard).toContainText('Copy this key now. Capgo won\'t show it again.')
    // The key is tracked on the app so its first use from CI completes the step.
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.cicdSetupCalls)).toEqual([{
      p_app_id: appId,
      p_event: 'key_created',
      p_apikey_rbac_id: '00000000-0000-4000-8000-000000000001',
      p_selection: { product: 'ota', strategy: 'main', provider: 'github' },
    }])
    const [create] = (await previewState(page)).apikeyCreates
    expect(create).toEqual({
      name: `GitHub Actions CI (${appId})`,
      hashed: true,
      bindings: [
        { role_name: 'org_member', scope_type: 'org', org_id: '00000000-0000-4000-8000-000000000002' },
        { role_name: 'app_uploader', scope_type: 'app', org_id: '00000000-0000-4000-8000-000000000002', app_id: '00000000-0000-4000-8000-000000000003' },
      ],
    })

    await page.locator('[data-test="cicd-copy-pipeline"]').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('name: Capgo live updates')

    // An uploader key cannot run Builder pipelines: a changed role asks for a new key.
    await page.locator('[data-test="cicd-product-builder"]').click()
    await expect(keyCard).toContainText('Role: App admin')
    await expect(keyCard.locator('[data-test="cicd-key-value-CAPGO_TOKEN"]')).toHaveCount(0)
    await keyCard.locator('[data-test="cicd-create-key-CAPGO_TOKEN"]').click()
    await expect(keyCard.locator('[data-test="cicd-key-value-CAPGO_TOKEN"]')).toHaveText('cap_ci_preview_key_2')
    expect((await previewState(page)).apikeyCreates[1].bindings[1].role_name).toBe('app_admin')
    // Going back to live updates shows the uploader key created earlier.
    await page.locator('[data-test="cicd-product-ota"]').click()
    await expect(keyCard.locator('[data-test="cicd-key-value-CAPGO_TOKEN"]')).toHaveText('cap_ci_preview_key_1')
  })

  test('creates a release key and a preview key for pull requests', async ({ page }) => {
    await page.goto(fixture)
    await page.locator('[data-test="cicd-strategy-pull_request"]').click()
    await page.locator('[data-test="cicd-provider-gitlab"]').click()
    await expect(page.locator('[data-test="cicd-pipeline-file"]')).toHaveText('.gitlab-ci.yml')
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).toContainText('on_stop: capgo-preview-cleanup')
    await expect(page.locator('[data-test="cicd-step-key"]').getByRole('heading')).toHaveText('Create the keys for CI')
    await expect(page.locator('[data-test="cicd-key-CAPGO_PREVIEW_TOKEN"]')).toContainText('Role: App preview')
    await expect(page.locator('[data-test="cicd-step-secret"]')).toContainText('Turn Protect variable off for CAPGO_PREVIEW_TOKEN')
    await expect(page.locator('[data-test="cicd-notes"]')).toContainText('its pr-<number> channel and bundle are deleted')
    await page.locator('[data-test="cicd-create-key-CAPGO_PREVIEW_TOKEN"]').click()
    await expect(page.locator('[data-test="cicd-key-value-CAPGO_PREVIEW_TOKEN"]')).toBeVisible()
    expect((await previewState(page)).apikeyCreates[0].bindings[1].role_name).toBe('app_preview')

    // Azure has no pull-request-closed event, so the guide explains manual cleanup.
    await page.locator('[data-test="cicd-provider-azure"]').click()
    await expect(page.locator('[data-test="cicd-note-cleanup-manual"]')).toContainText(`npx @capgo/cli@latest channel delete pr-<number> ${appId} --delete-bundle`)
    await expect(page.locator('[data-test="cicd-notes"]')).toContainText('Build validation')
    // A created key stays visible while the user switches providers.
    await expect(page.locator('[data-test="cicd-key-value-CAPGO_PREVIEW_TOKEN"]')).toBeVisible()
  })

  test('uses custom branches for main and preprod', async ({ page }) => {
    await page.goto(fixture)
    await page.locator('[data-test="cicd-strategy-main_preprod"]').click()
    await page.locator('[data-test="cicd-production-branch"]').fill('master')
    await page.locator('[data-test="cicd-preprod-branch"]').fill('staging')
    await page.locator('[data-test="cicd-provider-bitbucket"]').click()
    const content = page.locator('[data-test="cicd-pipeline-content"]')
    await expect(content).toContainText("'master':")
    await expect(content).toContainText("'staging':")
    await expect(content).toContainText('--channel preprod')
    await expect(page.locator('[data-test="cicd-key-CAPGO_TOKEN"]')).toContainText('Role: App developer')
    await page.locator('[data-test="cicd-preprod-branch"]').fill('bad branch')
    await expect(page.getByText('The pipeline uses preprod until then.')).toBeVisible()
    await expect(content).toContainText("'preprod':")
  })

  test('starts native builds with stored credentials for the platform from the checklist', async ({ page }) => {
    await page.goto(`${fixture}&product=builder&platform=android`)
    await expect(page.locator('[data-test="cicd-product-builder"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-test="cicd-platform-android"]')).toBeChecked()
    await expect(page.locator('[data-test="cicd-platform-ios"]')).not.toBeChecked()
    await page.locator('[data-test="cicd-provider-circleci"]').click()
    await expect(page.locator('[data-test="cicd-steps"] [data-test^="cicd-step-"]')).toHaveCount(5)
    await expect(page.locator('[data-test="cicd-step-credentials"]')).toContainText(`npx @capgo/cli@latest build credentials push ${appId} --platform android`)
    await expect(page.locator('[data-test="cicd-key-CAPGO_TOKEN"]')).toContainText('Role: App admin')
    const content = page.locator('[data-test="cicd-pipeline-content"]')
    await expect(content).toContainText('npx cap sync android')
    await expect(content).toContainText(`npx @capgo/cli@latest build request ${appId} --platform android --use-stored-credentials`)
    await expect(content).not.toContainText('--platform ios')
    // The last platform cannot be unchecked: the pipeline must build something.
    await page.locator('[data-test="cicd-platform-android"]').click()
    await expect(page.locator('[data-test="cicd-platform-android"]')).toBeChecked()
    await page.locator('[data-test="cicd-platform-ios"]').click()
    await expect(content).toContainText('--platform ios')
    await expect(page.locator('[data-test="cicd-detection"]')).toContainText('Waiting for the first build requested from CI…')

    // Pull request builds use a separate key that merge request pipelines can read.
    await page.locator('[data-test="cicd-strategy-pull_request"]').click()
    await expect(page.locator('[data-test="cicd-key-CAPGO_PREVIEW_TOKEN"]')).toContainText('Role: App admin')
    await expect(page.locator('[data-test="cicd-key-CAPGO_PREVIEW_TOKEN"]')).toContainText('keep it separate from the release key')
    await expect(content).toContainText('CAPGO_TOKEN="$CAPGO_PREVIEW_TOKEN" npx @capgo/cli@latest build request')
  })

  test('remembers answers per app and warns when there is no default channel', async ({ page }) => {
    await page.goto(`${fixture}&defaultChannel=0`)
    await page.locator('[data-test="cicd-provider-other"]').click()
    await expect(page.locator('[data-test="cicd-no-default-channel"]')).toBeVisible()
    await expect(page.locator('[data-test="cicd-pipeline-file"]')).toHaveText('shell')
    await page.reload()
    await expect(page.locator('[data-test="cicd-provider-other"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-test="cicd-steps"]')).toBeVisible()
  })

  test('keeps the real default channel and blocks one the CLI cannot target', async ({ page }) => {
    await page.goto(`${fixture}&defaultChannel=${encodeURIComponent('Live app')}`)
    await page.locator('[data-test="cicd-provider-github"]').click()
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).toContainText(`--channel 'Live app' --auto-bump patch`)
    await page.goto(`${fixture}&defaultChannel=${encodeURIComponent('beta,stable')}`)
    await expect(page.locator('[data-test="cicd-channel-unsupported"]')).toContainText('"beta,stable"')
    await expect(page.locator('[data-test="cicd-steps"]')).toHaveCount(0)
    // Native builds don't upload to a channel, so they stay available.
    await page.locator('[data-test="cicd-product-builder"]').click()
    await expect(page.locator('[data-test="cicd-channel-unsupported"]')).toHaveCount(0)
    await expect(page.locator('[data-test="cicd-steps"]')).toBeVisible()
  })

  test('shows when CI already shipped this app', async ({ page }) => {
    await page.goto(`${fixture}&cicd=detected`)
    await expect(page.locator('[data-test="cicd-status-detected"]')).toContainText('CI/CD is connected: Capgo received a bundle from GitHub Actions on')
    await expect(page.locator('[data-test="cicd-mark-done"]')).toHaveCount(0)
    await page.locator('[data-test="cicd-provider-github"]').click()
    await expect(page.locator('[data-test="cicd-detection"]')).toContainText('CI/CD is connected')
    await expect(page.locator('[data-test="cicd-detection-refresh"]')).toHaveCount(0)
  })

  test('lets users who already deploy from CI mark it as set up', async ({ page }) => {
    await page.goto(fixture)
    await page.locator('[data-test="cicd-mark-done"]').click()
    await expect(page.locator('[data-test="cicd-status-marked-done"]')).toContainText('Marked as set up on')
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.cicdSetupCalls)).toEqual([{ p_app_id: appId, p_event: 'marked_done' }])
    await page.goto(`${fixture}&cicd=marked`)
    await expect(page.locator('[data-test="cicd-status-marked-done"]')).toBeVisible()
    await expect(page.locator('[data-test="cicd-mark-done"]')).toHaveCount(0)
  })

  test('ships to every default channel when each platform has its own', async ({ page }) => {
    await page.goto(`${fixture}&defaultChannels=production-ios|production-android`)
    await page.locator('[data-test="cicd-provider-gitlab"]').click()
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).toContainText(`bundle upload ${appId} --channel production-android,production-ios --auto-bump patch`)
    await expect(page.locator('[data-test="cicd-strategy-main"]')).toContainText('ships a live update to the production-android, production-ios channel')
  })

  test('restores the encryption key in CI when the app encrypts its bundles', async ({ page }) => {
    await page.goto(`${fixture}&encrypted=1`)
    await expect(page.locator('[data-test="cicd-encrypted"]')).toBeChecked()
    await expect(page.locator('[data-test="cicd-encryption"]')).toContainText('Your latest bundle is encrypted')
    await page.locator('[data-test="cicd-provider-github"]').click()
    await expect(page.locator('[data-test="cicd-encryption-secret"]')).toContainText(`base64 < .capgo_key_v2 | tr -d '\\n' | gh secret set CAPGO_PRIVATE_KEY_BASE64`)
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).toContainText('echo "$CAPGO_PRIVATE_KEY_BASE64" | base64 -d > .capgo_key_v2')
    await expect(page.locator('[data-test="cicd-note-encryption"]')).toBeVisible()
    await page.locator('[data-test="cicd-encrypted"]').uncheck()
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).not.toContainText('.capgo_key_v2')
    await expect(page.locator('[data-test="cicd-encryption-secret"]')).toHaveCount(0)
  })

  test('explains when only an admin can create the CI key', async ({ page }) => {
    await page.goto(`${fixture}&apikeyError=forbidden_binding`)
    await page.locator('[data-test="cicd-provider-github"]').click()
    await page.locator('[data-test="cicd-create-key-CAPGO_TOKEN"]').click()
    await expect(page.getByRole('alert')).toHaveText('Only organization admins can create this key. Ask an admin, or create it on the API keys page.')
  })
  test('ignores public channels without an enabled platform', async ({ page }) => {
    await page.goto(`${fixture}&defaultChannel=stable&disabledPublicChannel=1`)
    await page.locator('[data-test="cicd-provider-github"]').click()
    const content = page.locator('[data-test="cicd-pipeline-content"]')
    await expect(content).toContainText('--channel stable --auto-bump patch')
    await expect(content).not.toContainText('disabled-public')
  })

  for (const setting of ['channels', 'encryption'] as const) {
    test(`blocks pipeline generation until ${setting} can be read`, async ({ page }) => {
      await page.goto(`${fixture}&defaultChannel=stable&${setting === 'channels' ? 'channelError' : 'encryptionError'}=1`)
      await page.locator('[data-test="cicd-provider-github"]').click()
      await expect(page.locator(`[data-test="cicd-${setting}-retry"]`)).toBeVisible()
      await expect(page.locator('[data-test="cicd-pipeline-content"]')).toHaveCount(0)
      await page.evaluate((key) => {
        (window as any).onboardingSetupPreview.state[key] = false
      }, setting === 'channels' ? 'channelError' : 'encryptionError')
      await page.locator(`[data-test="cicd-${setting}-retry"]`).click()
      await expect(page.locator('[data-test="cicd-pipeline-content"]')).toContainText('--channel stable --auto-bump patch')
    })
  }

  test('waits for encryption detection before showing a pipeline', async ({ page }) => {
    await page.clock.install()
    await page.goto(`${fixture}&encrypted=1&encryptionDelay=2000`)
    await page.locator('[data-test="cicd-provider-github"]').click()
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).toHaveCount(0)
    await page.clock.fastForward(2000)
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).toContainText('CAPGO_PRIVATE_KEY_BASE64')
  })

  test('retries key registration without replacing the one-time key', async ({ page }) => {
    await page.goto(`${fixture}&registrationError=1`)
    await page.locator('[data-test="cicd-provider-github"]').click()
    await page.locator('[data-test="cicd-create-key-CAPGO_TOKEN"]').click()
    await expect(page.locator('[data-test="cicd-key-value-CAPGO_TOKEN"]')).toHaveText('cap_ci_preview_key_1')
    await expect(page.locator('[data-test="cicd-key-registration-error-CAPGO_TOKEN"]')).toBeVisible()
    await page.evaluate(() => { (window as any).onboardingSetupPreview.state.cicdRegistrationError = false })
    await page.locator('[data-test="cicd-key-registration-retry-CAPGO_TOKEN"]').click()
    await expect(page.locator('[data-test="cicd-key-registration-error-CAPGO_TOKEN"]')).toHaveCount(0)
    await expect(page.locator('[data-test="cicd-key-value-CAPGO_TOKEN"]')).toHaveText('cap_ci_preview_key_1')
    expect((await previewState(page)).apikeyCreates).toHaveLength(1)
    const calls = await page.evaluate(() => (window as any).onboardingSetupPreview.cicdSetupCalls)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
  })

  for (const source of ['ci', 'key'] as const) {
    test(`keeps polling for Builder ${source} evidence when only live updates are connected`, async ({ page }) => {
      await page.clock.install()
      await page.goto(`${fixture}&cicd=detected`)
      await page.locator('[data-test="cicd-provider-github"]').click()
      await expect(page.locator('[data-test="cicd-detection"]')).toContainText('received a bundle')
      await page.locator('[data-test="cicd-product-builder"]').click()
      await expect(page.locator('[data-test="cicd-detection"]')).toContainText('Waiting for the first build requested from CI')
      await expect(page.locator('[data-test="cicd-status-detected"]')).toHaveCount(0)
      await page.evaluate((source) => {
        (window as any).onboardingSetupPreview.state.cicdRemoteLedger = {
          ota_detected_at: '2026-11-06T10:00:00.000Z',
          builder_detected_at: '2026-11-06T12:00:00.000Z',
          builder_detected_via: source,
          builder_ci_provider: source === 'ci' ? 'Azure Pipelines' : null,
          detected_via: 'ci',
          ci_provider: 'GitHub Actions',
        }
      }, source)
      await page.clock.fastForward(15000)
      await expect(page.locator('[data-test="cicd-detection"]')).toContainText(source === 'ci' ? 'received a build request from Azure Pipelines' : 'received a build request from the CI key created here')
    })
  }

  test('keeps a saved completion when an older status read finishes', async ({ page }) => {
    await page.goto(fixture)
    await page.locator('[data-test="cicd-provider-github"]').click()
    await expect(page.locator('[data-test="cicd-detection-refresh"]')).toBeEnabled()
    const before = await previewState(page)
    await page.evaluate(() => { (window as any).onboardingSetupPreview.state.cicdStatusDelayMs = 800 })
    await page.locator('[data-test="cicd-detection-refresh"]').click()
    await expect.poll(async () => (await previewState(page)).cicdStatusRequests).toBe(before.cicdStatusRequests + 1)
    await page.locator('[data-test="cicd-mark-done"]').click()
    await expect(page.locator('[data-test="cicd-status-marked-done"]')).toBeVisible()
    await expect.poll(async () => (await previewState(page)).cicdStatusResponses).toBe(before.cicdStatusResponses + 1)
    await expect(page.locator('[data-test="cicd-status-marked-done"]')).toBeVisible()
  })

  test('requires separate production and preproduction branches', async ({ page }) => {
    await page.goto(fixture)
    await page.locator('[data-test="cicd-strategy-main_preprod"]').click()
    await page.locator('[data-test="cicd-provider-github"]').click()
    await page.locator('[data-test="cicd-preprod-branch"]').fill('main')
    await expect(page.locator('[data-test="cicd-branches-equal"]')).toBeVisible()
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).toHaveCount(0)
    await page.locator('[data-test="cicd-preprod-branch"]').fill('preprod')
    await expect(page.locator('[data-test="cicd-pipeline-content"]')).toBeVisible()
  })

})
