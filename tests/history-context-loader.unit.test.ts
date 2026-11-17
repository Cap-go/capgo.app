import { describe, expect, it, vi } from 'vitest'
import { createHistoryContextLoader } from '../src/services/historyContext'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup() {
  const state = { scope: 'channel-a', version: null as string | null, members: [] as string[] }
  const loadCurrentVersion = vi.fn(async (isCurrent: () => boolean) => {
    if (isCurrent())
      state.version = `version-of-${state.scope}`
    return true
  })
  const loadMembers = vi.fn(async () => ['member'])
  const loader = createHistoryContextLoader({
    scopeKey: () => state.scope,
    loadCurrentVersion,
    loadMembers,
    applyMembers: (members) => {
      state.members = members
    },
  })
  return { state, loader, loadCurrentVersion, loadMembers }
}

describe('history context loader', () => {
  it('loads members and the current bundle once per scope, not on every page', async () => {
    const { state, loader, loadCurrentVersion, loadMembers } = setup()
    await loader.load()
    await loader.load()
    await loader.load()
    expect(loadCurrentVersion).toHaveBeenCalledTimes(1)
    expect(loadMembers).toHaveBeenCalledTimes(1)
    expect(state.members).toEqual(['member'])

    state.scope = 'channel-b'
    await loader.load()
    expect(loadCurrentVersion).toHaveBeenCalledTimes(2)
    expect(loadMembers).toHaveBeenCalledTimes(2)
  })

  it('refetches only the current bundle on an explicit reload', async () => {
    const { loader, loadCurrentVersion, loadMembers } = setup()
    await loader.load()
    await loader.load({ refreshCurrentVersion: true })
    expect(loadCurrentVersion).toHaveBeenCalledTimes(2)
    expect(loadMembers).toHaveBeenCalledTimes(1)
  })

  it('retries a failed part on the next load and keeps the other cached', async () => {
    const { loader, loadCurrentVersion, loadMembers } = setup()
    loadCurrentVersion.mockResolvedValueOnce(false)
    await loader.load()
    await loader.load()
    expect(loadCurrentVersion).toHaveBeenCalledTimes(2)
    expect(loadMembers).toHaveBeenCalledTimes(1)

    const second = setup()
    second.loadMembers.mockResolvedValueOnce([])
    await second.loader.load()
    await second.loader.load()
    expect(second.loadMembers).toHaveBeenCalledTimes(2)
    expect(second.loadCurrentVersion).toHaveBeenCalledTimes(1)
  })

  it('drops a superseded scope instead of caching its results under the new scope', async () => {
    const { state, loader, loadMembers } = setup()
    const slowMembers = deferred<string[]>()
    loadMembers.mockImplementationOnce(() => slowMembers.promise)
    const first = loader.load()
    state.scope = 'channel-b'
    await loader.load()
    slowMembers.resolve(['stale-member'])
    await first
    expect(state.version).toBe('version-of-channel-b')
    expect(state.members).toEqual(['member'])
  })
})
