import { describe, expect, it } from 'vitest'
import { shouldShowCLIActivity } from '../src/services/cliActivity'

describe('Realtime CLI feed', () => {
  it.concurrent('suppresses browser-login handshakes only', () => {
    expect(shouldShowCLIActivity({ channel: 'user-login' })).toBe(false)
    expect(shouldShowCLIActivity({ channel: 'bundle-upload' })).toBe(true)
  })
})
