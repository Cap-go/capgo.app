import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const channelPageSource = readFileSync(new URL('../src/pages/app/[app].channel.[channel].vue', import.meta.url), 'utf8')

describe('channel information rollout and update package UX', () => {
  it.concurrent('prevents double promote confirm from unlinking stable bundle', () => {
    expect(channelPageSource).toContain('confirmInFlight')
    expect(channelPageSource).toContain('const promotedVersionId = channel.value?.rollout_version')
  })

  it.concurrent('requires confirmation before changing download format or rollout percentage', () => {
    expect(channelPageSource).toContain('confirm-update-package')
    expect(channelPageSource).toContain('confirm-rollout-percentage')
    expect(channelPageSource).toContain('confirmConsequentialChannelChange')
    expect(channelPageSource).toContain('confirm-enable-rollout')
    expect(channelPageSource).toContain('confirm-disable-rollout')
    expect(channelPageSource).toContain('confirm-promote-rollout')
    expect(channelPageSource).toContain('confirm-rollback-rollout')
    expect(channelPageSource).toContain('confirm-set-rollout-target')
    expect(channelPageSource).toContain('confirm-pause-rollout')
    expect(channelPageSource).toContain('confirm-resume-rollout')
  })

  it.concurrent('documents update package options and applies rollout percentage explicitly', () => {
    expect(channelPageSource).toContain('getUpdatePackageDescription')
    expect(channelPageSource).toContain('update-package-all-description')
    expect(channelPageSource).toContain('applyRolloutPercentage')
    expect(channelPageSource).toContain('apply-rollout-percentage')
    expect(channelPageSource).toContain('rollout-percentage-help')
    expect(channelPageSource).not.toContain('saveRolloutPercentage')
  })
})
