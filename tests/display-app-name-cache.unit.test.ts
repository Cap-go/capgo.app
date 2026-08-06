import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockMaybeSingle = vi.fn()
const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }))
const mockSelect = vi.fn(() => ({ eq: mockEq }))
const mockFrom = vi.fn(() => ({ select: mockSelect }))

vi.mock('~/services/supabase', () => ({
  useSupabase: () => ({ from: mockFrom }),
}))

interface LookupResult {
  data: { name: string | null } | null
  error: unknown
}

function deferredLookup() {
  let resolve: (result: LookupResult) => void = () => {}
  const promise = new Promise<LookupResult>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

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
    const lookup = deferredLookup()
    mockMaybeSingle
      .mockReturnValueOnce(lookup.promise)
      .mockReturnValue(new Promise(() => {}))

    const { useDisplayStore } = await import('../src/stores/display.ts')
    const display = useDisplayStore()

    display.updatePathTitle('/app/com.missing.app')
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1)

    lookup.resolve({ data: null, error: null })
    await flushPromises()
    display.updatePathTitle('/app/com.missing.app')

    expect(mockMaybeSingle).toHaveBeenCalledTimes(1)
  })

  it('retries when the app row exists but its name is not ready', async () => {
    const lookup = deferredLookup()
    mockMaybeSingle
      .mockReturnValueOnce(lookup.promise)
      .mockReturnValue(new Promise(() => {}))

    const { useDisplayStore } = await import('../src/stores/display.ts')
    const display = useDisplayStore()

    display.updatePathTitle('/app/com.pending.app')
    lookup.resolve({ data: { name: null }, error: null })
    await flushPromises()
    display.updatePathTitle('/app/com.pending.app')

    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
  })

  it('ignores a missing result from the previous organization', async () => {
    const oldLookup = deferredLookup()
    mockMaybeSingle
      .mockReturnValueOnce(oldLookup.promise)
      .mockReturnValue(new Promise(() => {}))

    const { useDisplayStore } = await import('../src/stores/display.ts')
    const display = useDisplayStore()

    display.clearCachesForOrg('org-one')
    display.updatePathTitle('/app/com.shared.app')
    display.clearCachesForOrg('org-two')

    oldLookup.resolve({ data: null, error: null })
    await flushPromises()
    display.updatePathTitle('/app/com.shared.app')

    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
  })

  it('does not let an old request clear the new organization request', async () => {
    const oldLookup = deferredLookup()
    mockMaybeSingle
      .mockReturnValueOnce(oldLookup.promise)
      .mockReturnValue(new Promise(() => {}))

    const { useDisplayStore } = await import('../src/stores/display.ts')
    const display = useDisplayStore()

    display.clearCachesForOrg('org-one')
    display.updatePathTitle('/app/com.shared.app')
    display.clearCachesForOrg('org-two')
    display.updatePathTitle('/app/com.shared.app')

    oldLookup.resolve({ data: null, error: new Error('lookup failed') })
    await flushPromises()
    display.updatePathTitle('/app/com.shared.app')

    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
  })

  it('does not resolve the reserved new-app route as an app id', async () => {
    const { useDisplayStore } = await import('../src/stores/display.ts')
    const display = useDisplayStore()

    display.updatePathTitle('/app/new')

    expect(mockFrom).not.toHaveBeenCalled()
  })
})
