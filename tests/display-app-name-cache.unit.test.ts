import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockMaybeSingle = vi.fn()
const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }))
const mockSelect = vi.fn(() => ({ eq: mockEq }))
const mockFrom = vi.fn(() => ({ select: mockSelect }))

vi.mock('~/services/supabase', () => ({
  useSupabase: () => ({ from: mockFrom }),
}))

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('display app-name lookups', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('caches a successful missing-app lookup without retrying it', async () => {
    let resolveLookup: (result: { data: null, error: null }) => void = () => {}
    mockMaybeSingle
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveLookup = resolve
      }))
      .mockReturnValue(new Promise(() => {}))

    const { useDisplayStore } = await import('../src/stores/display.ts')
    const display = useDisplayStore()

    display.updatePathTitle('/app/com.missing.app')
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1)

    resolveLookup({ data: null, error: null })
    await flushPromises()
    display.updatePathTitle('/app/com.missing.app')

    expect(mockMaybeSingle).toHaveBeenCalledTimes(1)
  })

  it('does not resolve the reserved new-app route as an app id', async () => {
    const { useDisplayStore } = await import('../src/stores/display.ts')
    const display = useDisplayStore()

    display.updatePathTitle('/app/new')

    expect(mockFrom).not.toHaveBeenCalled()
  })
})
