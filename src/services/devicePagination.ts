/**
 * Cursor pagination helpers for the device table.
 *
 * `pageStartCursor` maps a page number to the cursor that starts it:
 * `undefined` for page 1 (no cursor), a string for a known page, and `null`
 * when the previous page was the last one (no rows after it).
 */

/** Must match MAX_DEVICES_PAGE_OFFSET in the backend (devicesPageOffset.ts). */
export const MAX_DEVICES_PAGE_OFFSET = 100_000

export interface DevicePageFetchPlan {
  /** Known page the request starts from (its cursor is `cursor`). */
  fromPage: number
  cursor: string | undefined
  /** Rows to skip after `cursor`; 0 when `fromPage` is the target. */
  offset: number
}

/**
 * Plan the single request that reaches `target` from the closest known page
 * at or before it, so jumping to a far page (the last-page button, a `?page=N`
 * URL) costs one request instead of one per page in between.
 *
 * Returns `null` when a known page before the target already ended the list.
 * When the jump exceeds `maxOffset`, the plan stops at the furthest reachable
 * page start; the caller stores that page's cursor and plans again.
 */
export function planDevicePageFetch(
  pageStartCursor: ReadonlyMap<number, string | null | undefined>,
  target: number,
  pageSize: number,
  maxOffset = MAX_DEVICES_PAGE_OFFSET,
): DevicePageFetchPlan | null {
  const page = Math.max(1, Math.trunc(target))
  let fromPage = 1
  for (const known of pageStartCursor.keys()) {
    if (known <= page && known > fromPage)
      fromPage = known
  }
  const cursor = pageStartCursor.get(fromPage)
  if (cursor === null)
    return null
  const maxPagesPerJump = Math.max(0, Math.floor(maxOffset / pageSize))
  const pagesToSkip = Math.min(page - fromPage, maxPagesPerJump)
  return { fromPage, cursor: cursor ?? undefined, offset: pagesToSkip * pageSize }
}

/** Page reached by a plan (the page whose rows the request returns). */
export function plannedDevicePage(plan: DevicePageFetchPlan, pageSize: number): number {
  return plan.fromPage + plan.offset / pageSize
}

/**
 * Cache of the count shown as "hidden by the time filter": it only depends on
 * the filters other than the date range, so date range changes and repeated
 * filter values reuse it instead of re-running an unbounded count.
 */
export class DeviceCountCache {
  private readonly entries = new Map<string, number>()
  private readonly maxEntries: number

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries
  }

  get(key: string): number | undefined {
    return this.entries.get(key)
  }

  set(key: string, value: number) {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined)
        break
      this.entries.delete(oldest)
    }
  }

  clear() {
    this.entries.clear()
  }
}
