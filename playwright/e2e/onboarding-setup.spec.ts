import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const fixture = '/playwright/fixtures/onboarding-setup.html'
const instructions = '[data-test="setup-checklist-instructions"]'

async function advanceProgressPolls(page: Page, count: number) {
  for (let i = 0; i < count; i++) {
    const requests = await page.evaluate(() => (window as any).onboardingSetupPreview.state.requests)
    await page.clock.runFor(2000)
    // Let response parsing finish between ticks, as it does with the real clock.
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.requests)).toBe(requests + 1)
  }
}

test.describe('Actionable onboarding setup checklist', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixture)
    await expect(page.getByRole('heading', { name: 'Set up your first live update' })).toBeVisible()
  })

  test('keeps all tasks visible and distinguishes inspecting a task from completing it', async ({ page }) => {
    await expect(page.locator('[data-test^="app-onboarding-cli-step-"]')).toHaveCount(7)
    await expect(page.locator('[data-test^="app-onboarding-cli-step-"] button')).toContainText([
      'Start guided setup Current task',
      'Create a channel',
      'Install Capgo Updater',
      'Add the app-ready code',
      'Run your app on a device',
      'Publish your first update',
      'Deliver an update to a device',
    ])
    await expect(page.getByRole('button', { name: 'Explore dashboard', exact: true })).toBeVisible()
    await expect(page.locator(instructions).getByRole('button', { name: 'Explore dashboard', exact: true })).toHaveCount(0)
    await expect(page.locator(instructions).getByRole('heading', { name: 'Start guided setup' })).toBeVisible()
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('0 of 7 complete')
    await expect(page.locator(instructions).getByRole('button', { name: 'Copy AI setup prompt', exact: true })).toBeVisible()
    await expect(page.locator(instructions).getByRole('link', { name: 'Manual setup guide', exact: false })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Manual setup guide', exact: false })).toHaveCount(1)
    await expect(page.locator(instructions).getByRole('button', { name: 'Send setup instructions', exact: true })).toHaveCount(0)

    await page.locator('[data-test="app-onboarding-cli-step-run_device"] button').click()
    await expect(page.locator(instructions).getByRole('heading', { name: 'Run your app on a device' })).toBeVisible()
    await expect(page.locator(instructions)).toContainText('Choose iOS or Android, build your app with Capgo installed')
    await expect(page.locator('[data-test="setup-checklist-start-actions"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Copy AI setup prompt', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-test="app-onboarding-cli-step-run_device"]')).toHaveAttribute('data-status', 'pending')
    await page.getByRole('button', { name: 'Back to the current task' }).click()
    await expect(page.locator(instructions).getByRole('heading', { name: 'Start guided setup' })).toBeVisible()

    await page.locator('[data-test="setup-checklist-copy-command"]').click()
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('copy-command')
    await page.locator('[data-test="setup-checklist-copy-ai"]').click()
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('copy-ai')
    await expect(page.getByText('They’ll need to complete the setup for you.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Send setup instructions', exact: true }).click()
    await expect(page.locator('#invite-email')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Explore dashboard', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('explore')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('0 of 7 complete')
    await page.getByRole('button', { name: 'Don\'t show this again' }).click()
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('hide')
  })

  test('follows persisted progress, counts skipped tasks, and stops polling on completion', async ({ page }) => {
    const time = new Date('2026-09-16T12:00:00Z')
    await page.clock.install({ time })
    await page.clock.pauseAt(time)
    await page.goto(fixture)
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.steps = {
        login_cli_mcp: { status: 'done' },
        add_code: { status: 'skipped' },
        add_encryption: { status: 'skipped' },
        select_platform: { status: 'done' },
        build_project: { status: 'done' },
        add_code_change: { status: 'done' },
        completion: { status: 'done' },
      }
    })
    await advanceProgressPolls(page, 1)
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('2 of 7 complete')
    await expect(page.locator(instructions).getByRole('heading', { name: 'Create a channel' })).toBeVisible()
    await expect(page.locator('[data-test="setup-checklist-start-actions"]')).toHaveCount(0)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_code"]')).toHaveAttribute('data-status', 'skipped')
    for (const id of ['add_encryption', 'select_platform', 'build_project', 'add_code_change', 'completion'])
      await expect(page.locator(`[data-test="app-onboarding-cli-step-${id}"]`)).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.version)).toBe(3)
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.steps.build_project)).toEqual({ status: 'done' })

    // Browsing a future task should survive background progress updates.
    await page.locator('[data-test="app-onboarding-cli-step-run_device"] button').click()
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.steps.add_updater = { status: 'done' }
    })
    await advanceProgressPolls(page, 1)
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('3 of 7 complete')
    await expect(page.locator(instructions).getByRole('heading', { name: 'Run your app on a device' })).toBeVisible()

    await page.evaluate(() => {
      Object.assign((window as any).onboardingSetupPreview.state.steps, {
        run_device: { status: 'done' },
        upload_bundle: { status: 'done' },
        test_update: { status: 'done' },
      })
    })
    await advanceProgressPolls(page, 1)
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('6 of 7 complete')
    for (const id of ['run_device', 'upload_bundle', 'test_update'])
      await expect(page.locator(`[data-test="app-onboarding-cli-step-${id}"]`)).toHaveAttribute('data-status', 'done')

    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.outcome = 'completed'
    })
    await advanceProgressPolls(page, 1)
    await expect(page.getByRole('heading', { name: 'Guided setup complete' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Explore dashboard', exact: true })).toHaveCount(0)
    const requests = await page.evaluate(() => (window as any).onboardingSetupPreview.state.requests)
    const channelRequests = await page.evaluate(() => (window as any).onboardingSetupPreview.state.channelRequests)
    await page.clock.runFor(10_000)
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.requests)).toBe(requests)
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.channelRequests)).toBe(channelRequests)
    await page.getByRole('button', { name: 'Open your app', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('complete')
  })

  test('polls one endpoint every two seconds with consecutive N and the app id on every request', async ({ page }) => {
    const time = new Date('2026-09-16T12:00:00Z')
    await page.clock.install({ time })
    await page.clock.pauseAt(time)
    await page.goto(fixture)
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.polls.length)).toBe(1)
    await page.clock.runFor(10_000)
    const polls = await page.evaluate(() => (window as any).onboardingSetupPreview.state.polls)
    expect(polls.map((poll: any) => poll.N)).toEqual([0, 1, 2, 3, 4, 5])
    expect(polls.every((poll: any) => poll.appId === 'com.example.onboarding-preview')).toBe(true)
    expect(polls.map((poll: any) => poll.initial)).toEqual([true, false, false, false, false, false])
  })

  test('keeps twelve goals for v1/v2 controls and seven for v3 in the compact checklist', async ({ page }) => {
    for (const version of [1, 2, 3]) {
      await page.goto(`${fixture}?version=${version}&view=compact`)
      const checklist = page.locator('[data-test="app-onboarding-cli-steps"]')
      await checklist.getByRole('button').click()
      await expect(checklist.locator('li')).toHaveCount(version === 3 ? 7 : 12)
      await expect(checklist).toContainText(version === 3 ? 'Publish your first update' : 'Upload bundle')
      await expect(checklist).toContainText(`0 of ${version === 3 ? 7 : 12} steps`)
      expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.version)).toBe(version)
    }
  })

  test('shows a relevant guide for every selected task in both checklist versions', async ({ page, context }) => {
    const onboarding = 'https://capgo.app/docs/getting-started/onboarding/'
    const guides: Record<string, string> = {
      add_app: onboarding,
      login_cli_mcp: onboarding,
      add_channel: `${onboarding}#step-3-create-production-channel`,
      add_updater: `${onboarding}#step-4-install-updater-plugin`,
      add_code: 'https://capgo.app/docs/plugins/updater/notify-app-ready/',
      run_device: `${onboarding}#step-9-run-on-device`,
      upload_bundle: 'https://capgo.app/docs/getting-started/deploy/#uploading-a-bundle',
      test_update: 'https://capgo.app/docs/getting-started/deploy/#receiving-an-update-on-a-device',
    }
    await page.setViewportSize({ width: 1190, height: 1322 })
    for (const version of [1, 2]) {
      await page.goto(`${fixture}?version=${version}`)
      for (const [id, href] of Object.entries(guides)) {
        if (id === (version === 1 ? 'login_cli_mcp' : 'add_app'))
          continue
        await page.locator(`[data-test="app-onboarding-cli-step-${id}"] button`).click()
        const title = await page.locator(instructions).getByRole('heading').textContent()
        const guide = page.locator('[data-test="setup-checklist-manual-guide"]')
        await expect(guide).toHaveAttribute('href', href)
        await expect(guide).toHaveText(id === 'add_app' || id === 'login_cli_mcp' ? 'Manual setup guide' : `Guide: ${title}`)
        await expect(guide).toHaveAttribute('target', '_blank')
        await expect(guide).toHaveAttribute('rel', 'noopener noreferrer')
      }
      await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('0 of 7 complete')
    }

    // Verify the link actually navigates without sending a request to production docs.
    await context.route('https://capgo.app/docs/**', route => route.fulfill({ contentType: 'text/html', body: 'Documentation preview' }))
    await page.locator('[data-test="app-onboarding-cli-step-upload_bundle"] button').click()
    const popupPromise = page.waitForEvent('popup')
    await page.locator('[data-test="setup-checklist-manual-guide"]').click()
    const popup = await popupPromise
    await popup.waitForLoadState()
    expect(popup.url()).toBe(guides.upload_bundle)
    await popup.close()
    await expect(page.locator(instructions).getByRole('heading', { name: 'Publish your first update' })).toBeVisible()
    await page.screenshot({ path: '.context/onboarding-design/task-guides-desktop.png', fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('[data-test="setup-checklist-mobile-toggle"]').click()
    await page.locator('[data-test="app-onboarding-cli-step-test_update"] button').click()
    const mobileGuide = page.locator('[data-test="setup-checklist-manual-guide"]')
    await expect(mobileGuide).toHaveAttribute('href', guides.test_update)
    await mobileGuide.scrollIntoViewIfNeeded()
    const panel = await page.locator(instructions).boundingBox()
    const guide = await mobileGuide.boundingBox()
    expect(guide!.x).toBeGreaterThanOrEqual(panel!.x)
    expect(guide!.x + guide!.width).toBeLessThanOrEqual(panel!.x + panel!.width)
    await page.screenshot({ path: '.context/onboarding-design/task-guides-mobile.png' })
  })

  test('creates a channel through the existing animated flow and tags every milestone as todo-list activity', async ({ page }) => {
    await page.setViewportSize({ width: 1190, height: 1322 })
    await page.locator('[data-test="app-onboarding-cli-step-add_channel"] button').click()
    await expect(page.locator(instructions)).toContainText('Waiting for a channel to be created')
    await page.screenshot({ path: '.context/onboarding-design/setup-channel-action.png', fullPage: true })
    await page.locator('[data-test="setup-checklist-create-channel"]').click()
    const dialog = page.getByRole('dialog', { name: 'Create a channel', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-test="channel-default-routing-animation"]')).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.channelEvents.map((event: any) => event.event))).toContain('onboarding_channel_animation_started')
    await dialog.getByRole('button', { name: /replay/i }).click()
    await page.screenshot({ path: '.context/onboarding-design/setup-channel-flow-routing.png', fullPage: true })
    await dialog.locator('[data-test="channel-default-routing-continue"]').click()
    await expect(dialog.locator('[data-test="channel-self-assign-stage"]')).toBeVisible()
    await dialog.locator('[data-test="channel-self-assign-back"]').click()
    await expect(dialog.locator('[data-test="channel-default-routing-animation"]')).toBeVisible()
    await dialog.locator('[data-test="channel-default-routing-continue"]').click()
    await dialog.locator('[data-test="channel-self-assign-continue"]').click()
    await expect(dialog.locator('[data-test="channel-console-assign-stage"]')).toBeVisible()
    await dialog.locator('[data-test="channel-console-assign-continue"]').click()
    await expect(dialog.locator('[data-test="channel-create-name"]')).toBeVisible()
    await expect(dialog.locator('[data-test="channel-create-submit"]')).toBeDisabled()
    await dialog.locator('[data-test="channel-create-name"]').fill('bad channel')
    await dialog.locator('[data-test="channel-create-name"]').blur()
    await expect(dialog).toContainText('Use only letters, numbers, dots, dashes, or underscores.')
    await dialog.getByRole('button', { name: /production.*recommended/i }).click()
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.channelInsertError = true
    })
    await dialog.locator('[data-test="channel-create-submit"]').click()
    await expect(dialog.getByRole('alert')).toContainText('We could not create this channel.')
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'pending')
    await page.evaluate(() => {
      const state = (window as any).onboardingSetupPreview.state
      state.channelInsertError = false
      state.channelInsertDelayMs = 1000
    })
    await page.screenshot({ path: '.context/onboarding-design/setup-channel-flow-create.png', fullPage: true })
    await dialog.locator('[data-test="channel-create-submit"]').click()
    await expect(dialog.locator('[data-test="setup-checklist-channel-close"]')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-test="channel-create-success"]')).toBeVisible()
    await dialog.locator('[data-test="channel-create-continue"]').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('1 of 7 complete')
    const result = await page.evaluate(() => {
      const preview = (window as any).onboardingSetupPreview
      return { events: preview.channelEvents, inserts: preview.state.channelInserts, steps: preview.state.steps }
    })
    expect(result.steps).toEqual({})
    expect(result.inserts.at(-1)).toMatchObject({
      app_id: 'com.example.onboarding-preview',
      name: 'production',
      public: true,
      allow_device_self_set: true,
      owner_org: '00000000-0000-4000-8000-000000000002',
      created_by: '00000000-0000-4000-8000-000000000001',
    })
    expect(result.events.every((event: any) => event.properties.channel_flow_origin === 'todo_list')).toBe(true)
    for (const event of ['onboarding_channel_flow_opened', 'onboarding_channel_animation_replayed', 'onboarding_channel_stage_backed', 'onboarding_channel_name_validation_failed', 'onboarding_channel_create_failed', 'onboarding_channel_create_submitted', 'onboarding_channel_create_succeeded', 'onboarding_channel_create_continued'])
      expect(result.events.map((entry: any) => entry.event)).toContain(event)
    expect(result.events.at(-1)).toMatchObject({ event: 'onboarding_channel_flow_closed', properties: { flow_exit_action: 'completed' } })
  })

  test('returns to the selected task on Escape and preserves origin on animation disposal', async ({ page }) => {
    await page.locator('[data-test="app-onboarding-cli-step-add_channel"] button').click()
    const create = page.locator('[data-test="setup-checklist-create-channel"]')
    await create.click()
    await expect(page.locator('[data-test="setup-checklist-channel-dialog"]')).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.channelEvents.map((event: any) => event.event))).toContain('onboarding_channel_animation_started')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(create).toBeFocused()
    await expect(page.locator(instructions).getByRole('heading', { name: 'Create a channel' })).toBeVisible()
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('0 of 7 complete')
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.channelEvents.map((event: any) => event.event))).toContain('onboarding_channel_animation_interrupted')
    await create.click()
    await expect(page.locator('[data-test="channel-default-routing-animation"]')).toBeVisible()
    await page.locator('[data-test="setup-checklist-channel-close"]').click()
    const events = await page.evaluate(() => (window as any).onboardingSetupPreview.channelEvents)
    expect(events.filter((entry: any) => entry.event === 'onboarding_channel_flow_opened')).toHaveLength(2)
    expect(events.filter((entry: any) => entry.event === 'onboarding_channel_flow_closed').every((entry: any) => entry.properties.flow_exit_action === 'closed')).toBe(true)
    expect(events.every((entry: any) => entry.properties.channel_flow_origin === 'todo_list')).toBe(true)
  })

  test('supports reduced motion on mobile and respects channel creation permissions', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.channelPermissions = false
    })
    await page.locator('[data-test="setup-checklist-mobile-toggle"]').click()
    await page.locator('[data-test="app-onboarding-cli-step-add_channel"] button').click()
    await page.locator('[data-test="setup-checklist-create-channel"]').click()
    await page.screenshot({ path: '.context/onboarding-design/setup-channel-flow-mobile.png', fullPage: true })
    const routingBounds = await page.locator('[data-test="channel-default-routing-animation"]').evaluate((stage) => {
      const bounds = stage.getBoundingClientRect()
      return Array.from(stage.querySelectorAll('.cr-channel-card, .cr-capgo-state')).every((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left >= bounds.left && rect.right <= bounds.right
      })
    })
    expect(routingBounds).toBe(true)
    for (const stage of ['default-routing', 'self-assign', 'console-assign']) {
      if (stage !== 'default-routing') {
        await page.screenshot({ path: `.context/onboarding-design/setup-channel-flow-mobile-${stage}.png`, fullPage: true })
        if (stage === 'self-assign') {
          const bounds = await page.locator('[data-test="channel-self-assign-stage"]').evaluate((stage) => {
            const bounds = stage.getBoundingClientRect()
            return Array.from(stage.querySelectorAll('.csa-routing-channel-card, .csa-capgo-state')).every((element) => {
              const rect = element.getBoundingClientRect()
              return rect.left >= bounds.left && rect.right <= bounds.right
            })
          })
          expect(bounds).toBe(true)
          const spacing = await page.locator('[data-test="channel-self-assign-stage"]').evaluate((stage) => {
            const label = stage.querySelector('.csa-channels-label')!.getBoundingClientRect()
            const cards = Array.from(stage.querySelectorAll('.csa-routing-channel-card')).map(element => element.getBoundingClientRect())
            const validation = stage.querySelector('.csa-validation-check')!.getBoundingClientRect()
            return { labelTop: label.top, labelBottom: label.bottom, firstCardTop: Math.min(...cards.map(card => card.top)), validationBottom: validation.bottom }
          })
          expect(spacing.firstCardTop).toBeGreaterThanOrEqual(spacing.labelBottom)
          expect(spacing.labelTop).toBeGreaterThanOrEqual(spacing.validationBottom)
        }
      }
      await page.locator(`[data-test="channel-${stage}-continue"]`).click()
    }
    await expect(page.locator('[data-test="channel-create-name"]')).toBeVisible()
    await page.locator('[data-test="channel-create-name"]').fill('production')
    await expect(page.locator('[data-test="channel-create-submit"]')).toBeDisabled()
    const result = await page.evaluate(() => ({
      events: (window as any).onboardingSetupPreview.channelEvents,
      inserts: (window as any).onboardingSetupPreview.state.channelInserts,
      overflow: document.querySelector('dialog')!.scrollWidth > document.querySelector('dialog')!.clientWidth,
    }))
    expect(result.overflow).toBe(false)
    expect(result.inserts).toEqual([])
    expect(result.events.filter((entry: any) => entry.event === 'onboarding_channel_reduced_motion_shown')).toHaveLength(3)
    expect(result.events).toContainEqual(expect.objectContaining({ event: 'onboarding_channel_create_loaded', properties: expect.objectContaining({ permission_state: 'denied', channel_flow_origin: 'todo_list' }) }))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.locator('[data-test="channel-create-submit"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.context/onboarding-design/setup-channel-flow-mobile-dark.png', fullPage: true })
  })

  test('reuses a channel created while explanations are open without inserting another one in either checklist version', async ({ page }) => {
    for (const version of [1, 2]) {
      await page.goto(`${fixture}?version=${version}`)
      await page.locator('[data-test="app-onboarding-cli-step-add_channel"] button').click()
      await page.locator('[data-test="setup-checklist-create-channel"]').click()
      await page.evaluate(() => {
        const preview = (window as any).onboardingSetupPreview
        preview.state.channels = [{ id: 9, app_id: preview.appId.value, name: 'existing', public: true, allow_device_self_set: false }]
      })
      for (const stage of ['default-routing', 'self-assign', 'console-assign'])
        await page.locator(`[data-test="channel-${stage}-continue"]`).click()
      await expect(page.locator('[data-test="channel-create-success"]')).toBeVisible()
      await expect(page.locator('[data-test="channel-create-success"]')).toContainText('existing')
      await page.locator('[data-test="channel-create-continue"]').click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')
      const result = await page.evaluate(() => ({ events: (window as any).onboardingSetupPreview.channelEvents, inserts: (window as any).onboardingSetupPreview.state.channelInserts }))
      expect(result.inserts).toEqual([])
      expect(result.events).toContainEqual(expect.objectContaining({ event: 'onboarding_channel_create_existing_detected', properties: expect.objectContaining({ found_existing_channel: true, created_in_onboarding: false, channel_flow_origin: 'todo_list' }) }))
    }
  })

  test('retains last known progress when refresh fails and recovers', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.error = true
    })
    await expect(page.locator(instructions)).toContainText('Couldn’t refresh setup progress.')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('0 of 7 complete')
    await page.evaluate(() => {
      const state = (window as any).onboardingSetupPreview.state
      state.error = false
      state.steps.login_cli_mcp = { status: 'done' }
    })
    await page.getByRole('button', { name: 'Refresh progress' }).click()
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('1 of 7 complete')
    await expect(page.locator(instructions).getByRole('heading', { name: 'Create a channel' })).toBeVisible()
    await expect(page.locator(instructions)).toContainText('Waiting for a channel to be created')
  })

  test('completes the channel task on load for any app channel in both checklist versions', async ({ page }) => {
    for (const version of [1, 2]) {
      await page.goto(`${fixture}?version=${version}&channel=1`)
      await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')
      await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('1 of 7 complete')
      await expect(page.locator(instructions).getByRole('heading', { name: 'Start guided setup' })).toBeVisible()
      expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.steps)).toEqual({})
      expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.channelQueries)).toEqual(['eq.com.example.onboarding-preview'])
      await page.locator('[data-test="app-onboarding-cli-step-add_channel"] button').click()
      await expect(page.locator(instructions).getByRole('heading', { name: 'Create a channel' })).toBeVisible()
      await expect(page.locator(instructions)).not.toContainText('We check on page load and every 10 seconds.')
    }
    await page.screenshot({ path: '.context/onboarding-design/setup-channel-detected.png' })
  })

  test('confirmed channel absence overrides saved done and skipped statuses in both checklist versions', async ({ page }) => {
    for (const version of [1, 2]) {
      for (const status of ['done', 'skipped']) {
        await page.goto(`${fixture}?version=${version}&channelStatus=${status}`)
        await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.channelRequests)).toBe(1)
        await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'pending')
        await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('0 of 7 complete')
        expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.steps.add_channel.status)).toBe(status)
      }
    }
  })

  test('unchecks a deleted channel despite saved completion and rechecks a recreated channel', async ({ page }) => {
    const time = new Date('2026-09-16T12:00:00Z')
    await page.clock.install({ time })
    await page.clock.pauseAt(time)
    await page.goto(`${fixture}?channel=1&channelStatus=done`)
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.channelRequests)).toBe(1)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.channels = []
    })
    await page.clock.runFor(9999)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')
    await page.clock.runFor(1)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'pending')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('0 of 7 complete')
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.steps.add_channel.status)).toBe('done')

    // Subsequent saved progress must not restore the channel's old done state.
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.steps.login_cli_mcp = { status: 'done' }
    })
    await page.clock.runFor(2000)
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('1 of 7 complete')
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'pending')
    await expect(page.locator(instructions).getByRole('heading', { name: 'Create a channel' })).toBeVisible()
    await page.screenshot({ path: '.context/onboarding-design/setup-channel-removed.png' })

    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.channels.push({ id: 2, app_id: 'com.example.onboarding-preview', name: 'production' })
    })
    await advanceProgressPolls(page, 4)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('2 of 7 complete')
    await expect(page.locator(instructions).getByRole('heading', { name: 'Install Capgo Updater' })).toBeVisible()
  })

  test('detects a new channel at ten seconds and retains it through progress and channel refresh failures', async ({ page }) => {
    const time = new Date('2026-09-16T12:00:00Z')
    await page.clock.install({ time })
    await page.clock.pauseAt(time)
    await page.goto(fixture)
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.channelRequests)).toBe(1)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'pending')
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.channels.push({ id: 1, app_id: 'com.example.onboarding-preview', name: 'staging' })
    })
    await page.clock.runFor(9999)
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.channelRequests)).toBe(1)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'pending')
    await page.clock.runFor(1)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('1 of 7 complete')

    await page.evaluate(() => {
      const state = (window as any).onboardingSetupPreview.state
      state.steps.login_cli_mcp = { status: 'done' }
      state.channelError = true
    })
    await advanceProgressPolls(page, 5)
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.channelRequests)).toBe(3)
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('2 of 7 complete')
    await expect(page.locator(instructions).getByRole('heading', { name: 'Install Capgo Updater' })).toBeVisible()
    // Let the client's retry backoff run while exercising failed requests.
    await page.clock.resume()
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.error = true
    })
    await expect(page.locator(instructions)).toContainText('Couldn’t refresh setup progress.')
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')

    await page.evaluate(() => {
      const state = (window as any).onboardingSetupPreview.state
      state.error = false
      state.channelError = false
    })
    await page.getByRole('button', { name: 'Refresh progress' }).click()
    await expect(page.locator(instructions)).not.toContainText('Couldn’t refresh setup progress.')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('2 of 7 complete')

    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.outcome = 'completed'
    })
    await page.clock.runFor(2000)
    await expect(page.getByRole('heading', { name: 'Guided setup complete' })).toBeVisible()
    const requests = await page.evaluate(() => {
      const state = (window as any).onboardingSetupPreview.state
      return [state.requests, state.channelRequests]
    })
    await page.clock.runFor(10_000)
    expect(await page.evaluate(() => {
      const state = (window as any).onboardingSetupPreview.state
      return [state.requests, state.channelRequests]
    })).toEqual(requests)
  })

  test('ignores delayed channel results from the previous app and polls the new app', async ({ page }) => {
    const time = new Date('2026-09-16T12:00:00Z')
    await page.clock.install({ time })
    await page.clock.pauseAt(time)
    await page.goto(`${fixture}?channel=1&channelDelay=4000`)
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.channelRequests)).toBe(1)
    await page.evaluate(() => {
      const preview = (window as any).onboardingSetupPreview
      preview.state.channelDelayMs = 0
      preview.appId.value = 'com.example.other-app'
    })
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.channelQueries)).toEqual([
      'eq.com.example.onboarding-preview',
      'eq.com.example.other-app',
    ])
    await page.clock.runFor(4000)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'pending')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('0 of 7 complete')
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.state.channels.push({ id: 2, app_id: 'com.example.other-app', name: 'production' })
    })
    await advanceProgressPolls(page, 3)
    await expect(page.locator('[data-test="app-onboarding-cli-step-add_channel"]')).toHaveAttribute('data-status', 'done')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveText('1 of 7 complete')
  })

  test('supports legacy checklist data and a mobile task picker without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${fixture}?version=1`)
    await expect(page.locator(instructions).getByRole('heading', { name: 'Start guided setup' })).toBeVisible()
    const toggle = page.locator('[data-test="setup-checklist-mobile-toggle"]')
    await toggle.click()
    await expect(page.locator('[data-test="app-onboarding-cli-step-test_update"]')).toBeVisible()
    await page.locator('[data-test="app-onboarding-cli-step-run_device"] button').click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(instructions).getByRole('heading', { name: 'Run your app on a device' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('renders desktop, mobile, dark and loading states without console errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(message.text())
    })
    await page.setViewportSize({ width: 1190, height: 1322 })
    await page.goto(fixture)
    await expect(page.locator('[data-test="app-onboarding-cli-step-test_update"]')).toBeVisible()
    const commandButton = await page.locator('[data-test="setup-checklist-copy-command"]').boundingBox()
    const aiButton = await page.locator('[data-test="setup-checklist-copy-ai"]').boundingBox()
    expect(commandButton).not.toBeNull()
    expect(aiButton).not.toBeNull()
    expect(Math.abs(commandButton!.y - aiButton!.y)).toBeLessThan(1)
    const panel = await page.locator(instructions).boundingBox()
    const manualGuide = await page.locator('[data-test="setup-checklist-manual-guide"]').boundingBox()
    expect(panel).not.toBeNull()
    expect(manualGuide).not.toBeNull()
    expect(panel!.y + panel!.height - manualGuide!.y - manualGuide!.height).toBeLessThanOrEqual(33)
    const dismissal = await page.getByRole('button', { name: 'Don\'t show this again' }).boundingBox()
    expect(dismissal).not.toBeNull()
    expect(dismissal!.y + dismissal!.height).toBeLessThanOrEqual(1322)
    await page.screenshot({ path: '.context/onboarding-design/setup-desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '.context/onboarding-design/setup-mobile.png' })
    await page.locator('[data-test="setup-checklist-copy-command"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.context/onboarding-design/setup-mobile-action.png' })
    await page.getByRole('button', { name: 'Explore dashboard', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: '.context/onboarding-design/setup-mobile-footer.png' })
    await page.setViewportSize({ width: 1190, height: 1322 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.evaluate(() => {
      document.documentElement.classList.add('dark')
      document.documentElement.dataset.theme = 'capgodark'
    })
    await page.screenshot({ path: '.context/onboarding-design/setup-dark.png' })
    expect(await page.locator(instructions).getByRole('heading', { name: 'Start guided setup' }).evaluate(element => getComputedStyle(element).color)).toBe('rgb(255, 255, 255)')
    await page.evaluate(() => {
      (window as any).onboardingSetupPreview.command.value = ''
    })
    await expect(page.locator('[data-test="setup-checklist-copy-command"]')).toBeDisabled()
    await expect(page.getByText('Creating your secure API key…')).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('Dashboard exploration and returning to v3 setup', () => {
  test.beforeEach(async ({ page }) => {
    const response = await page.request.get(fixture)
    const html = (await response.text()).replace('src="./onboarding-setup.ts', 'src="/playwright/fixtures/onboarding-setup.ts')
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().resourceType() === 'document' && (path.startsWith('/app/') || path === '/onboarding/app'))
        await route.fulfill({ body: html, contentType: 'text/html' })
      else
        await route.continue()
    })
  })

  const appId = 'com.example.onboarding-preview'
  const setup = `${fixture}?view=navigation&resume=${appId}&step=setup`

  test('routes legacy saved setup through channel creation first', async ({ page }) => {
    await page.goto(`${setup}&legacyChannel=1`)
    await expect(page.locator('[data-test="channel-default-routing-animation"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-setup-cli"]')).toHaveCount(0)
  })

  test('lands on the app dashboard, prompts on refresh, and returns to fullscreen setup', async ({ page }) => {
    await page.goto(setup)
    await expect(page.locator('[data-test="onboarding-setup-cli"]')).toBeVisible()
    await page.getByRole('button', { name: 'Explore dashboard', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/app/${appId}$`))
    await expect(page.getByRole('heading', { name: 'App dashboard', exact: true })).toBeVisible()
    await expect(page.getByText('Continue exploring or return to setup?', { exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.getByText('It looks like you have been exploring the dashboard.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Continue exploring', exact: true }).click()
    await expect(page.getByText('Continue exploring or return to setup?', { exact: true })).toHaveCount(0)
    await page.reload()
    await page.getByRole('button', { name: 'Come back to the setup', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/onboarding/app\\?resume=${appId}&step=setup$`))
    await expect(page.locator('[data-test="onboarding-setup-cli"]')).toBeVisible()
    await expect(page.locator('[data-test="getting-started-page"]')).toHaveCount(0)
  })

  test('resumes the app in its owning organization after exploring another organization', async ({ page }) => {
    await page.goto(`${setup}&wrongOrg=1`)
    await expect(page.locator('[data-test="onboarding-setup-cli"]')).toBeVisible()
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.selectedOrgId.value)).toBe('00000000-0000-4000-8000-000000000002')
    await expect(page.locator('[data-test^="app-onboarding-cli-step-"]')).toHaveCount(7)
  })

  test('stores permanent browser dismissal without hiding onboarding or removing the return button', async ({ page }) => {
    await page.goto(setup)
    await page.getByRole('button', { name: 'Explore dashboard', exact: true }).click()
    await expect(page.locator('[data-test="preview-app-dashboard"]')).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Don\'t show this again', exact: true }).click()
    expect(await page.evaluate(() => localStorage.getItem('capgo:onboarding-exploration-reminder-dismissed:00000000-0000-4000-8000-000000000001'))).toBe('true')
    await page.reload()
    await expect(page.locator('[data-test="preview-app-dashboard"]')).toBeVisible()
    await expect(page.getByText('Continue exploring or return to setup?', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Continue with setup', exact: true }).click()
    await expect(page.locator('[data-test="onboarding-setup-cli"]')).toBeVisible()
  })

  test('opens the fullscreen v3 checklist without exploration mode and keeps v2 getting-started', async ({ page }) => {
    await page.goto(`/app/${appId}/getting-started?version=3`)
    await expect(page.locator('[data-test="onboarding-setup-cli"]')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/onboarding/app\\?resume=${appId}&step=setup$`))
    await expect(page.locator('[data-test="getting-started-page"]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.events)).not.toContain('getting-started-mounted')
    await page.goto(`/app/${appId}/getting-started?version=2`)
    await expect(page.locator('[data-test="getting-started-page"]')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/app/${appId}/getting-started\\?version=2$`))
    await expect(page.locator('[data-test="onboarding-setup-cli"]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('getting-started-mounted')
  })

  test('links Getting started directly to fullscreen setup for v3 and the legacy page for v2', async ({ page }) => {
    await page.goto(`/app/${appId}?version=3`)
    const link = page.locator('[data-test="getting-started-nav-link"]')
    await expect(link).toHaveAttribute('href', `/onboarding/app?resume=${appId}&step=setup`)
    await link.click()
    await expect(page.locator('[data-test="onboarding-setup-cli"]')).toBeVisible()
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.events)).not.toContain('getting-started-mounted')

    await page.goto(`/app/${appId}?version=2`)
    await expect(link).toHaveAttribute('href', `/app/${appId}/getting-started`)
    await link.click()
    await expect(page.locator('[data-test="getting-started-page"]')).toBeVisible()
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('getting-started-mounted')
  })
})
