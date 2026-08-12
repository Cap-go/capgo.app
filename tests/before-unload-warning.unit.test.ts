// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerBeforeUnloadWarning } from '../src/utils/beforeUnloadWarning'

describe('before unload warning', () => {
  afterEach(() => vi.restoreAllMocks())

  it('registers the native warning and returns its cleanup', () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const cleanup = registerBeforeUnloadWarning(true)
    const [eventName, handler] = addListener.mock.calls[0] as unknown as ['beforeunload', EventListener]
    const event = { preventDefault: vi.fn(), returnValue: false } as unknown as BeforeUnloadEvent

    expect(eventName).toBe('beforeunload')
    handler(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe(true)

    cleanup()
    expect(removeListener).toHaveBeenCalledWith('beforeunload', handler)
  })

  it('does not register outside pre-organization onboarding', () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    registerBeforeUnloadWarning(false)()
    expect(addListener).not.toHaveBeenCalled()
  })
})
