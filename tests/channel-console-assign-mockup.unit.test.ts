import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mockupUrl = new URL('../src/components/dashboard/ChannelConsoleAssignMockup.vue', import.meta.url)
const wrapperUrl = new URL('../src/components/dashboard/ChannelConsoleAssignOnboarding.vue', import.meta.url)
const mockupSource = existsSync(mockupUrl) ? readFileSync(mockupUrl, 'utf8') : ''
const wrapperSource = existsSync(wrapperUrl) ? readFileSync(wrapperUrl, 'utf8') : ''
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

function expectSourceOrder(source: string, markers: string[]) {
  let previousIndex = -1
  for (const marker of markers) {
    const index = source.indexOf(marker, previousIndex + 1)
    expect(index, `Expected source marker after previous marker: ${marker}`).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

describe('channel console assignment animation', () => {
  it.concurrent('navigates from the organization dashboard to a dev channel override', () => {
    expect(mockupSource).toContain('const animation = gsap.timeline({')
    expectSourceOrder(mockupSource, [
      `.addLabel('dashboard-arrive'`,
      `.addLabel('open-apps'`,
      `.addLabel('open-acme'`,
      `.addLabel('open-devices'`,
      `.addLabel('open-device'`,
      `.addLabel('open-channel-override'`,
      `.addLabel('assign-dev'`,
      `.addLabel('assignment-complete'`,
    ])

    expect(mockupSource).toContain('Acme organization')
    expect(mockupSource).toContain('Acme Mobile')
    expect(mockupSource).toContain('abc-123')
    expect(mockupSource).toContain('1.1.0')
    expect(mockupSource).toContain('iOS 18.0')
    expect(mockupSource).toContain('>dev<')
  })

  it.concurrent('reproduces the recognizable Capgo console surfaces', () => {
    expect(mockupSource).toContain('data-test="channel-console-assign-stage"')
    expect(mockupSource).toContain('csa-console-sidebar')
    expect(mockupSource).toContain('csa-console-topbar')
    expect(mockupSource).toContain('csa-console-apps-table')
    expect(mockupSource).toContain('csa-console-app-tabs')
    expect(mockupSource).toContain('csa-console-devices-table')
    expect(mockupSource).toContain('csa-console-device-details')
    expect(mockupSource).toContain('csa-console-channel-menu')
    expect(mockupSource).toContain('csa-console-success-toast')
    expect(mockupSource).toContain('csa-console-dashboard-tabs')
    expect(mockupSource).toContain(`t('monthly-active')`)
    expect(mockupSource).toContain(`t('Storage')`)
    expect(mockupSource).toContain(`t('Bandwidth')`)
    expect(mockupSource).not.toContain(`t('channel-console-assign-dashboard-heading')`)

    expect(messages['channel-console-assign-kicker']).toBe('Channels · 3 of 4')
    expect(messages['channel-console-assign-title']).toBe('Assign a device from the Capgo console')
    expect(messages['channel-console-assign-description']).toContain('channel override')
    expect(messages['channel-console-assign-plan-active']).toBe('Plan active')
    expect(messages['channel-console-assign-success']).toBe('Channel override set')
    expect(messages['channel-console-assign-takeaway']).toBe('Device abc-123 now follows the dev channel.')
  })

  it.concurrent('uses the same measured target point for the cursor tip and click pulse', () => {
    expect(mockupSource).toContain(`const clickTargets = elements('.csa-console-click-target')`)
    expect(mockupSource).toContain(`const cursor = element('.csa-console-cursor')`)
    expect(mockupSource).toContain(`const clickPulse = element('.csa-console-click-pulse')`)
    expect(mockupSource).toContain('function moveAndClickTarget(')
    expect(mockupSource).toContain('const point = targetPoint(stage, target)')
    expect(mockupSource).toContain('x: targetRect.left - stageRect.left + targetRect.width / 2')
    expect(mockupSource).toContain('y: targetRect.top - stageRect.top + targetRect.height * 0.4')
    expect(mockupSource).toContain('.set(clickPulse, { x: point.x, y: point.y')
    expect(mockupSource).toContain('fill-slate-950 text-white')
    expect(mockupSource).not.toContain('fill-white text-slate-950')
    expect(mockupSource).toContain('left: 0;')
    expect(mockupSource).toContain('top: 0;')
    expect(mockupSource).toContain('offset = 0')
    expect(mockupSource).toContain('const hidePulseAt =')
    expect(mockupSource).toContain('.set(clickPulse, { autoAlpha: 0 }')
    expect(mockupSource).toContain(`moveAndClickTarget(animation, cursor, clickPulse, stage, appsNav, 'open-apps')`)
    expect(mockupSource).toContain('<span class="csa-app-row csa-console-click-target')
    expect(mockupSource).toContain('<span class="csa-device-row csa-console-click-target')
    expect(mockupSource).not.toContain('<div class="csa-app-row csa-console-click-target')
    expect(mockupSource).not.toContain('<div class="csa-device-row csa-console-click-target')
    for (const label of ['open-apps', 'open-acme', 'open-devices', 'open-device']) {
      expect(mockupSource).toContain(`'${label}+=1.08'`)
      expect(mockupSource).not.toContain(`'${label}+=0.78'`)
    }
    expect(mockupSource).toContain(`'assign-dev+=0.98'`)
    expect(mockupSource).not.toContain(`'assign-dev+=0.68'`)
    expect(mockupSource).toContain('height: clamp(27rem, 52vh, 30rem)')
    expect(mockupSource).not.toContain('overflow-y-auto')
  })

  it.concurrent('supports final state, replay, reduced motion, cleanup, and onboarding continuation', () => {
    expect(mockupSource).toContain('function showFinalState()')
    expect(mockupSource).toContain('gsap.matchMedia()')
    expect(mockupSource).toContain(`'(prefers-reduced-motion: reduce)'`)
    expect(mockupSource).toContain('timeline?.restart()')
    expect(mockupSource).toContain('timeline?.kill()')
    expect(mockupSource).toContain('media?.revert()')
    expect(mockupSource).toContain('back: []')
    expect(mockupSource).toContain('data-test="channel-console-assign-back"')
    expect(mockupSource).toContain(`@click="emit('back')"`)
    expect(mockupSource).toContain('data-test="channel-console-assign-continue"')
    expect(mockupSource).toContain('class="d-btn d-btn-primary h-12 min-h-12 shrink-0 px-5"')
    expect(mockupSource).toContain(`{{ t('continue') }}`)
    expect(wrapperSource).toContain('back: []')
    expect(wrapperSource).toContain('@back="emit(\'back\')"')
    expect(wrapperSource).toContain('@continue="emit(\'continue\')"')
  })
})
