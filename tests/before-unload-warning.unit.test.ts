// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { useBeforeUnloadWarning } from '../src/utils/beforeUnloadWarning'

function mountWarning(enabled: boolean) {
  let complete = () => {}
  const app = createApp(defineComponent({
    setup() {
      complete = useBeforeUnloadWarning(enabled)
      return () => null
    },
  }))
  app.mount(document.createElement('div'))
  return { app, complete }
}

describe('before unload warning', () => {
  afterEach(() => vi.restoreAllMocks())

  it('registers the native warning and returns its cleanup', () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const { complete } = mountWarning(true)
    const [eventName, handler] = addListener.mock.calls[0] as unknown as ['beforeunload', EventListener]
    const event = { preventDefault: vi.fn(), returnValue: false } as unknown as BeforeUnloadEvent

    expect(eventName).toBe('beforeunload')
    handler(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe(true)

    complete()
    expect(removeListener).toHaveBeenCalledWith('beforeunload', handler)
  })

  it('does not register outside pre-organization onboarding', () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    mountWarning(false)
    expect(addListener).not.toHaveBeenCalled()
  })

  it('removes the warning when onboarding unmounts', () => {
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const { app } = mountWarning(true)
    app.unmount()
    expect(removeListener).toHaveBeenCalledWith('beforeunload', expect.any(Function))
  })
})
