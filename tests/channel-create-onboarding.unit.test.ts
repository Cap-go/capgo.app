import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const componentUrl = new URL('../src/components/dashboard/ChannelCreateOnboarding.vue', import.meta.url)
const componentSource = existsSync(componentUrl) ? readFileSync(componentUrl, 'utf8') : ''
const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

function expectSourceOrder(source: string, markers: string[]) {
  let previousIndex = -1
  for (const marker of markers) {
    const index = source.indexOf(marker, previousIndex + 1)
    expect(index, `Expected source marker after previous marker: ${marker}`).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

describe('channel creation onboarding', () => {
  it.concurrent('places a required creation step between the three explanations and CLI', () => {
    expect(onboardingSource).toContain(`import ChannelCreateOnboarding from './ChannelCreateOnboarding.vue'`)
    expect(onboardingSource).toContain(`type SetupStage = 'channel-routing' | 'channel-self-assign' | 'channel-console-assign' | 'channel-create' | 'cli'`)
    expectSourceOrder(onboardingSource, [
      `setupStage.value = 'channel-self-assign'`,
      `setupStage.value = 'channel-console-assign'`,
      `setupStage.value = 'channel-create'`,
      `setupStage.value = 'cli'`,
    ])
    expect(onboardingSource.match(/<ChannelCreateOnboarding/g)).toHaveLength(2)
    expect(onboardingSource.match(/<ChannelCreateOnboarding\s+v-else-if="setupStage === 'channel-create'"\s+:app-id="createdApp.app_id"/g)).toHaveLength(2)
  })

  it.concurrent('creates a real default channel for the onboarding app', () => {
    expect(componentSource).toContain(`checkPermissions('app.create_channel', { appId: props.appId })`)
    expect(componentSource).toContain(`checkPermissions('app.update_settings', { appId: props.appId })`)
    expect(componentSource).toContain(`.from('channels')`)
    expect(componentSource).toContain('.insert({')
    expect(componentSource).toContain('app_id: props.appId')
    expect(componentSource).toContain('owner_org: currentOrganization.value.gid')
    expect(componentSource).toContain('created_by: main.user.id')
    expect(componentSource).toContain('public: true')
    expect(componentSource).toContain('allow_device_self_set: allowSelfAssign.value')
    expect(componentSource).toContain('version: null')
    expect(componentSource).toContain(`.select('id, name, public, allow_device_self_set')`)
    expect(componentSource).toContain('.single()')
  })

  it.concurrent('requires an explicit valid name and confirms the saved channel before continuing', () => {
    expect(componentSource).toContain(`const CHANNEL_NAME_PATTERN = /^[\\w.-]+$/`)
    expect(componentSource).toContain('data-test="channel-create-name"')
    expect(componentSource).toContain('data-test="channel-create-submit"')
    expect(componentSource).toContain('data-test="channel-create-success"')
    expect(componentSource).toContain('data-test="channel-create-continue"')
    expect(componentSource).toContain('@submit.prevent="createChannel"')
    expect(componentSource).toContain(`emit('continue')`)
    expect(componentSource).toContain(`.eq('app_id', props.appId)`)
    expect(componentSource).toContain(`.eq('name', normalizedName)`)
    expect(componentSource).toContain('.maybeSingle()')
  })

  it.concurrent('concludes the four-part story in user-facing copy', () => {
    expect(messages['channel-create-onboarding-kicker']).toBe('Channels · 4 of 4')
    expect(messages['channel-create-onboarding-title']).toBe('Create your first channel')
    expect(messages['channel-create-onboarding-description']).toContain('real release route')
    expect(messages['channel-create-onboarding-default-title']).toBe('Default channel')
    expect(messages['channel-create-onboarding-self-assign-title']).toBe('Allow device self-assignment')
    expect(messages['channel-create-onboarding-submit']).toBe('Create channel')
    expect(messages['channel-create-onboarding-success-title']).toBe('Your first channel is ready')
  })
})
