import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Row { update_mode: string, website_url: string | null }
interface Result { data: Row | null, error: Error | null }

const queue: Array<Promise<Result>> = []

vi.mock('~/services/console', () => {
  function builder() {
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'update'])
      chain[method] = () => chain
    chain.maybeSingle = () => queue.shift() ?? Promise.resolve({ data: null, error: null })
    return chain
  }
  return { useConsole: () => ({ from: () => builder() }) }
})

const { useAppUpdateModeStore } = await import('../src/stores/appUpdateMode')

function deferred() {
  let resolve!: (value: Result) => void
  const promise = new Promise<Result>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('appUpdateMode store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    queue.length = 0
  })

  it('does not cache a failed load, so the next load retries', async () => {
    const store = useAppUpdateModeStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    queue.push(Promise.resolve({ data: null, error: new Error('network') }))
    expect(await store.load('com.example.app')).toBeNull()
    expect(consoleError).toHaveBeenCalled()
    queue.push(Promise.resolve({ data: { update_mode: 'website', website_url: 'https://app.example.com/' }, error: null }))
    expect(await store.load('com.example.app')).toEqual({ updateMode: 'website', websiteUrl: 'https://app.example.com/' })
    expect(store.isWebsiteMode('com.example.app')).toBe(true)
    consoleError.mockRestore()
  })

  it('keeps a saved state when a load started during the save resolves late', async () => {
    const store = useAppUpdateModeStore()
    const write = deferred()
    const read = deferred()
    queue.push(write.promise, read.promise)
    const saving = store.save('com.example.app', { updateMode: 'website', websiteUrl: 'https://app.example.com/' })
    const loading = store.load('com.example.app', true)
    write.resolve({ data: { update_mode: 'website', website_url: 'https://app.example.com/' }, error: null })
    await saving
    read.resolve({ data: { update_mode: 'capgo', website_url: null }, error: null })
    await loading
    expect(store.get('com.example.app')).toEqual({ updateMode: 'website', websiteUrl: 'https://app.example.com/' })
  })

  it('primes from an apps row only when the mode is unknown', () => {
    const store = useAppUpdateModeStore()
    store.prime('com.example.app', { update_mode: 'website', website_url: 'https://app.example.com/' })
    expect(store.isWebsiteMode('com.example.app')).toBe(true)
    store.prime('com.example.app', { update_mode: 'capgo', website_url: null })
    expect(store.isWebsiteMode('com.example.app')).toBe(true)
  })
})
