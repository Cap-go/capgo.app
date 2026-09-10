import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mockupUrl = new URL('../src/components/dashboard/ChannelSelfAssignMockup.vue', import.meta.url)
const wrapperUrl = new URL('../src/components/dashboard/ChannelSelfAssignOnboarding.vue', import.meta.url)
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

describe('channel self-assignment animation', () => {
  it.concurrent('runs the opt-in story as a single labeled GSAP timeline', () => {
    expect(mockupSource).toContain('const animation = gsap.timeline({')
    expectSourceOrder(mockupSource, [
      `.addLabel('open-app')`,
      `.addLabel('open-settings')`,
      `.addLabel('open-beta-dialog')`,
      `.addLabel('confirm-beta')`,
      `.addLabel('dismiss-phone')`,
      `.addLabel('show-code')`,
      `.addLabel('validate-channel')`,
      `.addLabel('routing-arrive'`,
      `.addLabel('routing-request'`,
      `.addLabel('routing-lookup'`,
      `.addLabel('routing-allowed'`,
      `.addLabel('store-on-device'`,
    ])
    expect(mockupSource).toContain(`'.csa-app-icon'`)
    expect(mockupSource).toContain(`'.csa-settings-nav'`)
    expect(mockupSource).toContain(`'.csa-beta-button'`)
    expect(mockupSource).toContain(`'.csa-confirm-button'`)
    expect(mockupSource).toContain(`'.csa-code-panel'`)
    expect(mockupSource).toContain(`'.csa-routing-scene'`)
    expect(mockupSource).toContain(`'.csa-request-packet'`)
    expect(mockupSource).toContain('csa-routing-device')
    expect(mockupSource).toContain('csa-routing-capgo')
    expect(mockupSource).toContain(`'.csa-routing-channel-card'`)
    expect(mockupSource).toContain(`'.csa-local-channel'`)
  })

  it.concurrent('shows the requested beta opt-in, version change, and plugin call', () => {
    expect(messages['channel-self-assign-title']).toBe('Self-assign devices to a channel')
    expect(messages['channel-self-assign-beta-action']).toBe('Become a beta tester')
    expect(messages['channel-self-assign-dialog-confirm']).toBe('Okay, become a beta tester')
    expect(messages['channel-self-assign-dialog-description']).toContain('latest features')
    expect(messages['channel-self-assign-dialog-description']).toContain('bugs')

    expect(mockupSource).toContain('1.0.0')
    expect(mockupSource).toContain('1.1.0-beta.1')
    expect(mockupSource).toContain('CapacitorUpdater.setChannel')
    expect(mockupSource).toContain(`channel: 'beta'`)
    expect(mockupSource).toContain('triggerAutoUpdate: true')
    expect(mockupSource).toContain('allow_device_self_set: true')
  })

  it.concurrent('explains Capgo validation and device-local channel storage in a compact canvas', () => {
    expect(messages['channel-self-assign-validation-request']).toBe('Can this device self-assign to beta?')
    expect(messages['channel-self-assign-validation-checking']).toBe('Checking whether beta allows device self-assignment…')
    expect(messages['channel-self-assign-validation-check']).toBe('Device self-assignment is enabled')
    expect(messages['channel-self-assign-channels-label']).toBe('Channel policies')
    expect(messages['channel-self-assign-response-title']).toBe('Self-assignment allowed')
    expect(messages['channel-self-assign-device-storage-title']).toBe('Saved on this device')
    expect(messages['channel-self-assign-device-storage-value']).toBe('Assigned channel: beta')
    expect(messages['channel-self-assign-takeaway-title']).toBe('Capgo validates. The device remembers.')

    expect(mockupSource).toContain('data-test="channel-self-assign-stage"')
    expect(mockupSource).toContain('height: clamp(27rem, 52vh, 30rem)')
    expect(mockupSource).toContain('csa-phone relative h-[29rem] w-[14.5rem]')
    expect(mockupSource).not.toContain('h-[28rem] w-[18rem]')
    expect(mockupSource).not.toContain('top: 36rem')

    expectSourceOrder(mockupSource, [
      'csa-routing-device',
      'csa-routing-capgo',
      'csa-channels-label',
      'csa-production-policy',
      'csa-beta-policy',
      'csa-staging-policy',
    ])
    expect(mockupSource).toContain('viewBox="0 0 1000 680"')
  })

  it.concurrent('reveals device success only after approval and bridges disconnected return paths invisibly', () => {
    expectSourceOrder(mockupSource, [
      `const deviceCheck = element('.csa-routing-device-check')`,
      'gsap.set(deviceCheck, { autoAlpha: 0, scale: 0.4 })',
      `.addLabel('store-on-device'`,
      '.to(deviceCheck, { autoAlpha: 1, scale: 1',
    ])

    const returnJourney = mockupSource.slice(mockupSource.indexOf('path: reverseBetaPoints'))
    expectSourceOrder(returnJourney, [
      'path: reverseBetaPoints',
      '.to(responsePacket, { autoAlpha: 0, scale: 0.55, duration: 0.14 })',
      `.to(element('.csa-capgo-core')`,
      '.set(responsePacket, { autoAlpha: 1, scale: 1 })',
      'path: reverseRequestPoints',
    ])
  })

  it.concurrent('keeps the channel row comfortably below Capgo and clears beta from the side paths', () => {
    expect(mockupSource).toContain(`.csa-channels-label {
  top: 17.75rem;`)
    expect(mockupSource).toContain(`.csa-routing-channel-node {
  top: 19.25rem;`)
    expect(mockupSource).toContain('d="M500 365 C320 398 200 446 193 480"')
    expect(mockupSource).toContain('d="M500 365 C680 398 800 446 807 480"')
  })

  it.concurrent('supports replay, reduced motion, cleanup, and onboarding continuation', () => {
    expect(mockupSource).toContain('gsap.matchMedia()')
    expect(mockupSource).toContain('\'(prefers-reduced-motion: reduce)\'')
    expect(mockupSource).toContain('timeline?.restart()')
    expect(mockupSource).toContain('timeline?.kill()')
    expect(mockupSource).toContain('media?.revert()')
    expect(mockupSource).toContain('back: []')
    expect(mockupSource).toContain('data-test="channel-self-assign-back"')
    expect(mockupSource).toContain(`@click="emit('back')"`)
    expect(mockupSource).toContain('data-test="channel-self-assign-continue"')
    expect(mockupSource).toContain('class="d-btn d-btn-primary min-h-12 gap-2 px-5"')
    expect(mockupSource).toContain(`{{ t('continue') }}`)
    expect(wrapperSource).toContain('back: []')
    expect(wrapperSource).toContain('@back="emit(\'back\')"')
    expect(wrapperSource).toContain('@continue="emit(\'continue\')"')
  })
})
