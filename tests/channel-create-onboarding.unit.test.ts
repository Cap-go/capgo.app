import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Minimal source guards for regressions that are hard to exercise without a browser:
// the onboarding channel INSERT must not depend on channel-read RLS, and analytics must
// never ship the raw channel name.
const componentSource = readFileSync(new URL('../src/components/dashboard/ChannelCreateOnboarding.vue', import.meta.url), 'utf8')

describe('channel creation onboarding', () => {
  it.concurrent('inserts the channel without chaining a RLS-dependent select', () => {
    const channelInsert = componentSource.slice(componentSource.indexOf(`const { error } = await capgo`), componentSource.indexOf(`completedChannel.value = {`))
    expect(channelInsert).toContain(`.from('channels')`)
    expect(channelInsert).not.toContain('.select(')
  })

  it.concurrent('tracks channel name length instead of the raw channel name', () => {
    expect(componentSource).not.toContain('channel_name:')
    expect(componentSource).toContain('channel_name_length:')
  })
})
