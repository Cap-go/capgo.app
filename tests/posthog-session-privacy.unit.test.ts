// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'

vi.mock('~/services/console', () => ({ isLocal: () => false }))

const { posthogLoader } = await import('../src/services/posthog')

afterEach(() => vi.unstubAllGlobals())

it('keeps chat payloads and tokens out of replay even if network capture is enabled remotely', () => {
  const init = vi.fn()
  vi.stubGlobal('posthog', { __loaded: true, init })
  posthogLoader('https://api.capgo.test')

  expect(init).toHaveBeenCalledOnce()
  const config = init.mock.calls[0][1]
  expect(config.session_recording).toMatchObject({ recordBody: false, recordHeaders: false })
})
