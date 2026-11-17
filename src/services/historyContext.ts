/**
 * Per-scope cache for the context the history tables need besides their rows:
 * the organization members (to show who deployed) and the channel's current
 * bundle (to label "current" and offer rollback).
 *
 * Both only depend on the scope (organization, app, channel or bundle), so they
 * load once per scope instead of on every page or search change. The current
 * bundle is refetched on an explicit reload, since it can change from the CLI
 * or another browser while the page is open. Each part is cached only after it
 * loaded, and the results of a superseded load are dropped.
 */
export interface HistoryContextLoader {
  load: (options?: { refreshCurrentVersion?: boolean }) => Promise<void>
}

export function createHistoryContextLoader<Member>(options: {
  /** Identifies the current scope; a change invalidates both cached parts. */
  scopeKey: () => string
  /** Loads the current bundle; applies it only while `isCurrent()`; resolves false on failure. */
  loadCurrentVersion: (isCurrent: () => boolean) => Promise<boolean>
  /** Loads the members; an empty list means the request failed. */
  loadMembers: () => Promise<Member[]>
  applyMembers: (members: Member[]) => void
}): HistoryContextLoader {
  let membersScopeKey = ''
  let versionScopeKey = ''
  let generation = 0

  return {
    async load(loadOptions = {}) {
      const key = options.scopeKey()
      const loadGeneration = ++generation
      const isCurrent = () => loadGeneration === generation && key === options.scopeKey()
      const needVersion = loadOptions.refreshCurrentVersion === true || versionScopeKey !== key
      const needMembers = membersScopeKey !== key
      if (!needVersion && !needMembers)
        return
      const [versionLoaded, loadedMembers] = await Promise.all([
        needVersion ? options.loadCurrentVersion(isCurrent) : Promise.resolve(true),
        needMembers ? options.loadMembers() : Promise.resolve(null),
      ])
      if (!isCurrent())
        return
      if (needVersion && versionLoaded)
        versionScopeKey = key
      if (loadedMembers) {
        options.applyMembers(loadedMembers)
        // An empty list means the members request failed: retry on the next load.
        if (loadedMembers.length > 0)
          membersScopeKey = key
      }
    },
  }
}
