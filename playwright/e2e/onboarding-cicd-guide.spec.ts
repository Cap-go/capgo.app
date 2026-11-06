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
    await expect(page.locator('[data-test="cicd-product-ota"]')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('[data-test="cicd-strategy-main"]')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('[data-test="cicd-strategy-main"]')).toContainText('Every merge to main ships a live update to the production channel.')
    await expect(page.locator('[data-test="cicd-steps"]')).toHaveCount(0)
    await expect(page.locator('[data-test="cicd-choose-provider"]')).toBeVisible()

    await page.locator('[data-test="cicd-provider-github"]').click()
    const steps = page.locator('[data-test="cicd-steps"]')
    await expect(steps.getByRole('heading', { name: 'Set up GitHub Actions' })).toBeVisible()
    await expect(steps.locator('[data-test^="cicd-step-"]')).toHaveCount(4)
    await expect(page.locator('[data-test="cicd-pipeline-file"]')).toHaveText('.github/workflows/capgo.yml')
    const content = page.locator('[data-test="cicd-pipeline-content"]')
    await expect(content).toContainText('branches: [main]')
    await expect(content).toContainText(`npx @capgo/cli@latest bundle upload ${appId} --channel production --auto-bump patch --fail-on-incompatible`)
    await expect(content).toContainText('CAPGO_TOKEN: ${{ secrets.CAPGO_TOKEN }}')
    await expect(page.locator('[data-test="cicd-step-secret"]')).toContainText('Name it CAPGO_TOKEN, paste the key, and click Add secret.')
    await expect(page.locator('[data-test="cicd-step-secret"]')).toContainText('gh secret set CAPGO_TOKEN')
    await expect(page.locator('[data-test="cicd-latest"]')).toContainText('No bundle uploaded yet.')

    const keyCard = page.locator('[data-test="cicd-key-CAPGO_TOKEN"]')
    await expect(keyCard).toContainText('Role: App uploader')
    await keyCard.locator('[data-test="cicd-create-key-CAPGO_TOKEN"]').click()
    await expect(keyCard.locator('[data-test="cicd-key-value-CAPGO_TOKEN"]')).toHaveText('cap_ci_preview_key_1')
    await expect(keyCard).toContainText('Copy this key now. Capgo won\'t show it again.')
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
    await expect(content).toContainText('master:')
    await expect(content).toContainText('staging:')
    await expect(content).toContainText('--channel preprod')
    await expect(page.locator('[data-test="cicd-key-CAPGO_TOKEN"]')).toContainText('Role: App developer')
    await page.locator('[data-test="cicd-preprod-branch"]').fill('bad branch')
    await expect(page.getByText('The pipeline uses preprod until then.')).toBeVisible()
    await expect(content).toContainText('preprod:')
  })

  test('starts native builds with stored credentials for the platform from the checklist', async ({ page }) => {
    await page.goto(`${fixture}&product=builder&platform=android`)
    await expect(page.locator('[data-test="cicd-product-builder"]')).toHaveAttribute('aria-checked', 'true')
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
    await expect(page.locator('[data-test="cicd-latest"]')).toContainText('No build requested yet.')

    // Pull request builds use a separate key that merge request pipelines can read.
    await page.locator('[data-test="cicd-strategy-pull_request"]').click()
    await expect(page.locator('[data-test="cicd-key-CAPGO_PREVIEW_TOKEN"]')).toContainText('Role: App admin')
    await expect(page.locator('[data-test="cicd-key-CAPGO_PREVIEW_TOKEN"]')).toContainText('keep it separate from the release key')
    await expect(content).toContainText('CAPGO_TOKEN="$CAPGO_PREVIEW_TOKEN" npx @capgo/cli@latest build request')
  })

  test('remembers answers per app and warns when there is no default channel', async ({ page }) => {
    await page.goto(`${fixture}&defaultChannel=0&bundle=1.4.2`)
    await page.locator('[data-test="cicd-provider-other"]').click()
    await expect(page.locator('[data-test="cicd-no-default-channel"]')).toBeVisible()
    await expect(page.locator('[data-test="cicd-pipeline-file"]')).toHaveText('shell')
    await expect(page.locator('[data-test="cicd-latest"]')).toContainText('Latest bundle: 1.4.2')
    await page.reload()
    await expect(page.locator('[data-test="cicd-provider-other"]')).toHaveAttribute('aria-checked', 'true')
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

  test('explains when only an admin can create the CI key', async ({ page }) => {
    await page.goto(`${fixture}&apikeyError=forbidden_binding`)
    await page.locator('[data-test="cicd-provider-github"]').click()
    await page.locator('[data-test="cicd-create-key-CAPGO_TOKEN"]').click()
    await expect(page.getByRole('alert')).toHaveText('Only organization admins can create this key. Ask an admin, or create it on the API keys page.')
  })
})
